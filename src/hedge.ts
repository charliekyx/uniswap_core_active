import { ethers } from "ethers";

import {
    AAVE_POOL_ADDR,
    AAVE_POOL_ABI,
    WETH_DEBT_TOKEN_ADDR,
    USDC_TOKEN,
    WETH_TOKEN,
    ERC20_ABI,
    SWAP_ROUTER_ADDR,
    SWAP_ROUTER_ABI,
    POOL_FEE,
    TX_TIMEOUT_MS,
    AAVE_TARGET_HEALTH_FACTOR,
    AAVE_MIN_HEALTH_FACTOR,
    DELTA_NEUTRAL_THRESHOLD,
    QUOTER_ADDR,
    QUOTER_ABI,
    SLIPPAGE_TOLERANCE,
} from "../config";

import { withRetry, waitWithTimeout, sendEmailAlert, getPoolTwap } from "./utils";
import { saveState } from "./state";
import { atomicExitPosition } from "./actions";

const RATE_MODE_VARIABLE = 2; // Aave Variable Rate

export class AaveManager {
    private wallet: ethers.Wallet;
    private poolContract: ethers.Contract;
    private swapRouter: ethers.Contract;
    private quoter: ethers.Contract;

    constructor(wallet: ethers.Wallet) {
        this.wallet = wallet;
        this.poolContract = new ethers.Contract(
            AAVE_POOL_ADDR,
            AAVE_POOL_ABI,
            wallet
        );
        this.swapRouter = new ethers.Contract(
            SWAP_ROUTER_ADDR,
            SWAP_ROUTER_ABI,
            wallet
        );
        this.quoter = new ethers.Contract(QUOTER_ADDR, QUOTER_ABI, wallet);
    }

    // --- Info Getters ---

    async getHealthFactor(): Promise<number> {
        const data = await withRetry(() =>
            this.poolContract.getUserAccountData(this.wallet.address)
        );
        // If totalCollateralBase is very small, HF might be huge, treat as safe (999.0)
        if (data.totalCollateralBase === 0n) return 999.0;
        if (data.healthFactor > 100n * 10n ** 18n) return 999.0;
        return parseFloat(ethers.formatUnits(data.healthFactor, 18));
    }

    async getCurrentEthDebt(): Promise<bigint> {
        if (WETH_DEBT_TOKEN_ADDR === ethers.ZeroAddress) return 0n;
        const debtContract = new ethers.Contract(
            WETH_DEBT_TOKEN_ADDR,
            ["function balanceOf(address) view returns (uint256)"],
            this.wallet
        );
        return await withRetry(() =>
            debtContract.balanceOf(this.wallet.address)
        );
    }

    // --- Safety Checks ---


    /**
     * Checks health factor. If low, verifies price integrity before panicking.
     * @param lpTokenId Token ID of the position
     * @param uniPoolContract Uniswap V3 Pool Contract (for TWAP check)
     */
    async checkHealthAndPanic(lpTokenId: string, uniPoolContract: ethers.Contract): Promise<boolean> {
        try {
            const hf = await this.getHealthFactor();

            // Thresholds
            const HF_WARNING = AAVE_MIN_HEALTH_FACTOR; // e.g., 1.5
            const HF_CRITICAL = 1.1; // Absolute liquidation danger zone

            if (hf < HF_WARNING) {
                console.warn(`[Risk] Health Factor Low: ${hf.toFixed(4)} < ${HF_WARNING}`);

                // 1. Check for Price Manipulation (Flash Increase)
                // If HF is low BUT not yet critical (1.1 < HF < 1.5), we check if this is a temporary spike.
                if (hf > HF_CRITICAL) {
                    try {
                        const twapTick = Number(await getPoolTwap(uniPoolContract, 300)); // 5 min TWAP
                        const slot0 = await uniPoolContract.slot0();
                        const currentTick = Number(slot0.tick);
                        const tickDiff = Math.abs(currentTick - twapTick);
                        
                        // 2% deviation threshold (~200 ticks)
                        if (tickDiff > 200) {
                            console.warn(`[Hedge] Price deviation detected (${tickDiff} ticks). Possible Flash Manipulation.`);
                            console.warn(`[Hedge] HF (${hf.toFixed(2)}) is above Critical (${HF_CRITICAL}). SUPPRESSING PANIC.`);
                            await sendEmailAlert("Hedge Warning", `HF Low (${hf}) but Price Deviated. Holding position to avoid buying top.`);
                            
                            // Return true (Pretend safe) to avoid locking the bot in Safe Mode, 
                            // allowing it to check again in the next block.
                            return true; 
                        }
                    } catch (e) {
                        console.error("[Hedge] Failed to check TWAP during risk assessment:", e);
                        // If check fails, default to safety -> proceed to panic logic below
                    }
                }

                // 2. If HF is Critical OR Price is consistent (Real crash) -> PANIC
                console.warn(`[Risk] Executing PANIC EXIT. (HF: ${hf.toFixed(4)})`);
                await this.panicExitAll(lpTokenId);
                return false; // Signal Safe Mode
            }

            return true;
        } catch (e) {
            console.error("[Aave] Health check failed:", e);
            return true;
        }
    }

    /**
     * Borrow more WETH from Aave and swap them to USDC for hedging.
     * Includes slippage protection via Quoter.
     * @param amountEth
     * @returns
     */
    async increaseShort(amountEth: bigint) {
        const hf = await this.getHealthFactor();
        if (hf < AAVE_TARGET_HEALTH_FACTOR) {
            console.warn(
                `   [Hedge] Health Factor low (${hf.toFixed(2)}). Skipping borrow.`
            );
            await sendEmailAlert(
                "Hedge Warning",
                `Health Factor low (${hf}). Skipping borrow.`
            );
            return;
        }

        console.log(
            `   [Hedge] OPEN SHORT: Borrowing ${ethers.formatUnits(amountEth, 18)} ETH...`
        );

        try {
            const txBorrow = await this.poolContract.borrow(
                WETH_TOKEN.address,
                amountEth,
                RATE_MODE_VARIABLE,
                0,
                this.wallet.address
            );
            await waitWithTimeout(txBorrow, TX_TIMEOUT_MS);
        } catch (e) {
            console.error("   [Hedge] Borrow failed (Check Collateral):", e);
            return;
        }

        console.log(`   [Hedge] Selling borrowed ETH for USDC...`);

        // 1. Quote to get minimum output amount
        const quoteParams = {
            tokenIn: WETH_TOKEN.address,
            tokenOut: USDC_TOKEN.address,
            amountIn: amountEth,
            fee: POOL_FEE,
            sqrtPriceLimitX96: 0
        };
        const [quotedOut] = await this.quoter.getFunction("quoteExactInputSingle").staticCall(quoteParams);
        
        // Apply Slippage
        const tolerance = BigInt(SLIPPAGE_TOLERANCE.numerator.toString());
        const basis = BigInt(SLIPPAGE_TOLERANCE.denominator.toString());
        const amountOutMin = quotedOut * (basis - tolerance) / basis;

        // 2. Execute Swap
        const txSwap = await this.swapRouter.exactInputSingle({
            tokenIn: WETH_TOKEN.address,
            tokenOut: USDC_TOKEN.address,
            fee: POOL_FEE,
            recipient: this.wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 300,
            amountIn: amountEth,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0,
        });
        await waitWithTimeout(txSwap, TX_TIMEOUT_MS);
        console.log(`   [Hedge] Short Position Increased. Sold for ${ethers.formatUnits(quotedOut, 6)} USDC`);
    }

    /**
     * Pay back Aave with WETH. If not enough WETH in wallet, try swapping USDC first.
     * Includes slippage protection and insufficient balance deadlock prevention.
     * @param amountEth
     * @returns
     */
    async decreaseShort(amountEth: bigint, force: boolean = false) {
        console.log(
            `   [Hedge] CLOSE SHORT: Repaying ${ethers.formatUnits(amountEth, 18)} ETH...`
        );

        if (force) {
            console.warn("   [Hedge] FORCE MODE: Increasing slippage tolerance to 5% to ensure execution.");
        }

        const wethContract = new ethers.Contract(
            WETH_TOKEN.address,
            ERC20_ABI,
            this.wallet
        );
        let currentWeth = await wethContract.balanceOf(this.wallet.address);

        // --- Auto-Swap Logic ---
        if (currentWeth < amountEth) {
            const deficit = amountEth - currentWeth;

            // Check USDC Balance first
            const usdcContract = new ethers.Contract(USDC_TOKEN.address, ERC20_ABI, this.wallet);
            const usdcBal = await usdcContract.balanceOf(this.wallet.address);

            // 1. Quote ExactOutput (How much USDC needed to buy exactly `deficit` ETH?)
            const quoteParams = {
                tokenIn: USDC_TOKEN.address,
                tokenOut: WETH_TOKEN.address,
                amount: deficit,
                fee: POOL_FEE,
                sqrtPriceLimitX96: 0
            };

            let amountInMax: bigint;
            let useExactInput = false;

            try {
                // QuoterV2 return: (amountIn, ... )
                const [quotedIn] = await this.quoter.getFunction("quoteExactOutputSingle").staticCall(quoteParams);
                
                // Calculate Slippage: Max In = Quoted * (1 + tolerance)
              let toleranceNumerator: bigint;  
                if (force) {
                    toleranceNumerator = 500n; // Force: 5%
                } else {
                    toleranceNumerator = BigInt(SLIPPAGE_TOLERANCE.numerator.toString()); // Normal: 0.5%
                }
                
                const basis = 10000n;
                amountInMax = quotedIn * (basis + toleranceNumerator) / basis;

                console.log(`   [Quote] Need ~${ethers.formatUnits(quotedIn, 6)} USDC to buy deficit ETH.`);

                // [Deadlock Logic Fix] Check if USDC is sufficient
                if (amountInMax > usdcBal) {
                    console.warn(`   [Hedge] Insufficient USDC for exact repayment. Swapping ALL USDC (${ethers.formatUnits(usdcBal, 6)}) instead.`);
                    useExactInput = true;
                }

            } catch (e) {
                console.warn("   [Hedge] Quote failed (likely insufficient liquidity for ExactOutput). Falling back to ExactInput.");
                useExactInput = true;
                amountInMax = 0n; // Not used
            }

            try {
                let txSwap;
                if (useExactInput) {
                    // Fallback: ExactInputSingle (Sell all USDC)
                    // We need to re-quote to get minOut
                    const quoteInParams = {
                        tokenIn: USDC_TOKEN.address,
                        tokenOut: WETH_TOKEN.address,
                        amountIn: usdcBal,
                        fee: POOL_FEE,
                        sqrtPriceLimitX96: 0
                    };
                    const [qOut] = await this.quoter.getFunction("quoteExactInputSingle").staticCall(quoteInParams);
                   let toleranceNumerator: bigint;
                    if (force) {
                        toleranceNumerator = 500n; // 5%
                    } else {
                        toleranceNumerator = BigInt(SLIPPAGE_TOLERANCE.numerator.toString()); // 0.5%
                    }
                    
                    const basis = 10000n;
                    const minOut = qOut * (basis - toleranceNumerator) / basis;

                    txSwap = await this.swapRouter.exactInputSingle({
                        tokenIn: USDC_TOKEN.address,
                        tokenOut: WETH_TOKEN.address,
                        fee: POOL_FEE,
                        recipient: this.wallet.address,
                        deadline: Math.floor(Date.now() / 1000) + 300,
                        amountIn: usdcBal,
                        amountOutMinimum: minOut,
                        sqrtPriceLimitX96: 0,
                    });
                } else {
                    // Standard: ExactOutputSingle
                    txSwap = await this.swapRouter.exactOutputSingle({
                        tokenIn: USDC_TOKEN.address,
                        tokenOut: WETH_TOKEN.address,
                        fee: POOL_FEE,
                        recipient: this.wallet.address,
                        deadline: Math.floor(Date.now() / 1000) + 300,
                        amountOut: deficit,
                        amountInMaximum: amountInMax, // Set slippage cap
                        sqrtPriceLimitX96: 0,
                    });
                }
                
                await waitWithTimeout(txSwap, TX_TIMEOUT_MS);
                
                // Update balance after swap
                currentWeth = await wethContract.balanceOf(this.wallet.address);

            } catch (e) {
                console.error("   [Hedge] Swap USDC->WETH failed:", e);
                return; // Stop if swap fails
            }
        }

        // Repay Logic
        // If we did a fallback swap, we might still not have enough WETH to repay `amountEth`.
        // So we repay min(currentWeth, amountEth).
        const repayAmount = currentWeth < amountEth ? currentWeth : amountEth;

        try {
            const tx = await this.poolContract.repay(
                WETH_TOKEN.address,
                force === true ? ethers.MaxUint256 : repayAmount, // If force is true, use MaxUint256 to repay all
                RATE_MODE_VARIABLE,
                this.wallet.address
            );
            await waitWithTimeout(tx, TX_TIMEOUT_MS);
            console.log(`   [Hedge] Repay Confirmed (${ethers.formatEther(repayAmount)} ETH).`);
        } catch (e) {
            console.error(`   [Aave] Repay Failed:`, e);
            sendEmailAlert("[Aave] Repay Failed", "Tx Failed or Insufficient Balance");
        }
    }
    
    async panicExitAll(lpTokenId: string) {
        console.log(`\n[CRITICAL EXIT] Initiating panic cleanup!`);

        // 1. Alert (Fail-safe)
        try {
            const hf = await this.getHealthFactor();
            await sendEmailAlert("CRITICAL: Panic Exit", `HF ${hf}. Exiting all positions.`);
        } catch (e) {
            console.error("   [Panic] Failed to send initial alert:", e);
        }

        // 2. BREAK LP FIRST (Get the WETH back!)
        try {
            if (lpTokenId && lpTokenId !== "0") {
               await atomicExitPosition(this.wallet, lpTokenId);

                await saveState("0"); // The program will restart itself; it is important to reset position token
                console.log("   [Panic] LP Closed & State Reset.");
            }
        } catch (e) {
            console.error("   [Panic] Failed to close LP:", e);
            await sendEmailAlert("[Panic] Failed to close LP", String(e));
        }

        // 3. Repay Debt
        try {
            const currentDebt = await this.getCurrentEthDebt();
            if (currentDebt > 0n) {
                console.log(`   [Aave] Found debt: ${ethers.formatEther(currentDebt)} ETH`);
                await this.decreaseShort(currentDebt, true); // Force usage of all assets in wallet to repay Aave
            }
        } catch (e) {
            console.error("   [Panic] Failed to repay Aave debt:", e);
            await sendEmailAlert("[Panic] Failed to repay Aave debt", String(e));
        }

        console.log(`[EXIT] Panic Cleanup Complete. Entering SAFE MODE.`);
    }

    async adjustHedge(lpEthAmount: bigint, lpTokenId: string) {
        // Double check safety level 
        const hf = await this.getHealthFactor();
        if (hf < AAVE_MIN_HEALTH_FACTOR) {
            await this.panicExitAll(lpTokenId);
            return;
        }

        console.log(`\n[Hedge] Checking Delta Neutrality...`);

        const currentDebt = await this.getCurrentEthDebt();
        const diff = lpEthAmount - currentDebt;

        console.log(
            `   [Status] LP Long: ${ethers.formatEther(lpEthAmount)} ETH | Aave Short: ${ethers.formatEther(currentDebt)} ETH`
        );
        console.log(`   [Status] Net Delta: ${ethers.formatEther(diff)} ETH`);

        if (diff > DELTA_NEUTRAL_THRESHOLD) {
            // Long > Short -> Increase Hedge
            await this.increaseShort(diff);
        } else if (diff < -DELTA_NEUTRAL_THRESHOLD) {
            // Short > Long -> Decrease Hedge
            const repayAmt = -diff;
            await this.decreaseShort(repayAmt);
        } else {
            console.log(`   [Hedge] Balanced.`);
        }
    }
}