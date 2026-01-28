import { ethers } from "ethers";

import { Pool, Position } from "@uniswap/v3-sdk";
import { Token, CurrencyAmount, Percent } from "@uniswap/sdk-core";

import {
    USDC_TOKEN,
    WETH_TOKEN,
    POOL_FEE,
    ERC20_ABI,
    NPM_ABI,
    SWAP_ROUTER_ABI,
    NONFUNGIBLE_POSITION_MANAGER_ADDR,
    SWAP_ROUTER_ADDR,
    MAX_UINT128,
    SLIPPAGE_TOLERANCE,
    TX_TIMEOUT_MS,
    POOL_ABI,
    V3_FACTORY_ADDR,
    RSI_OVERBOUGHT,
    RSI_OVERSOLD,
    REBALANCE_THRESHOLD_USDC,
    REBALANCE_THRESHOLD_WETH,
    ATR_SAFETY_FACTOR,
    QUOTER_ADDR,
    QUOTER_ABI,
} from "../config";

import { withRetry, waitWithTimeout, getPoolTwap, sendEmailAlert, sleep } from "./utils";
import { saveState } from "./state";
import { getEthAtr, getEthRsi } from "./analytics";

// --- Wallet Utilities ---
export async function getBalance(
    token: Token,
    wallet: ethers.Wallet
): Promise<bigint> {
    const contract = new ethers.Contract(token.address, ERC20_ABI, wallet);
    return await withRetry(() => contract.balanceOf(wallet.address));
}

export async function approveAll(wallet: ethers.Wallet) {
    const tokens = [USDC_TOKEN, WETH_TOKEN];
    const spenders = [
        NONFUNGIBLE_POSITION_MANAGER_ADDR,
        SWAP_ROUTER_ADDR,
    ];

    for (const token of tokens) {
        const contract = new ethers.Contract(token.address, ERC20_ABI, wallet);
        for (const spender of spenders) {
            const allowance = await withRetry(() =>
                contract.allowance(wallet.address, spender)
            );
            const threshold = ethers.MaxUint256 / 2n;

            if (allowance < threshold) {
                console.log(
                    `[Approve] Authorizing ${token.symbol} for ${spender}...`
                );
                const tx = await contract.approve(spender, ethers.MaxUint256);
                await waitWithTimeout(tx, TX_TIMEOUT_MS);
                console.log(`[Approve] Success.`);
            }
        }
    }
}

// --- Core Actions ---
export async function atomicExitPosition(
    wallet: ethers.Wallet,
    tokenId: string
): Promise<{ amount0: bigint, amount1: bigint }> {
    console.log(`\n[Exit] Executing Atomic Exit for Token ${tokenId}...`);
    const npm = new ethers.Contract(
        NONFUNGIBLE_POSITION_MANAGER_ADDR,
        NPM_ABI,
        wallet
    );

    const pos = await withRetry(() => npm.positions(tokenId));
    const liquidity = pos.liquidity;

    const calls: string[] = [];
    const iface = npm.interface;

    // 1. Decrease Liquidity
    if (liquidity > 0n) {
        const decreaseData = {
            tokenId: tokenId,
            liquidity: liquidity,
            amount0Min: 0,
            amount1Min: 0,
            deadline: Math.floor(Date.now() / 1000) + 120,
        };
        calls.push(
            iface.encodeFunctionData("decreaseLiquidity", [decreaseData])
        );
    }

    // 2. Collect Fees
    // This collects both Principal (from decreaseLiquidity) and Fees.
    // The result will be a mix of USDC and WETH depending on the pool price vs position range.
    const collectData = {
        tokenId: tokenId,
        recipient: wallet.address,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
    };
    calls.push(iface.encodeFunctionData("collect", [collectData]));

    // 3. Burn NFT
    calls.push(iface.encodeFunctionData("burn", [tokenId]));

    try {
        const tx = await npm.multicall(calls, { value: 0 });
        const receipt = await waitWithTimeout(tx, TX_TIMEOUT_MS);
        console.log(`   Atomic Exit Successful! (Tx: ${tx.hash})`);

        // [Analysis] Parse logs to find out how much we collected (Principal + Fees)
        let collected0 = 0n;
        let collected1 = 0n;
        
        for (const log of receipt.logs) {
            try {
                const parsed = npm.interface.parseLog(log);
                if (parsed && parsed.name === "Collect") {
                    collected0 += parsed.args.amount0;
                    collected1 += parsed.args.amount1;
                }
            } catch (e) { /* ignore other events */ }
        }
        console.log(`   [Exit] Collected: ${collected0} / ${collected1}`);
        return { amount0: collected0, amount1: collected1 };
    } catch (e) {
        console.error(`   Atomic Exit Failed:`, e);
        throw e;
    }
}

export async function smartRebalance(
    wallet: ethers.Wallet,
    configuredPool: Pool,
    tickLower: number,
    tickUpper: number
) {
    console.log(`\n[Rebalance] Calculating Smart Swap for range [${tickLower}, ${tickUpper}]...`);

    const balUSDC = await getBalance(USDC_TOKEN, wallet);
    const balWETH = await getBalance(WETH_TOKEN, wallet);

    const priceWethToUsdc =
        configuredPool.token0.address === WETH_TOKEN.address
            ? configuredPool.token0Price
            : configuredPool.token1Price;

    // 1. Calculate the Ideal Ratio for the new range
    // We create a mock position with infinite liquidity to see what ratio Uniswap wants
    const mockPosition = Position.fromAmounts({
        pool: configuredPool,
        tickLower,
        tickUpper,
        amount0: MAX_UINT128.toString(), 
        amount1: MAX_UINT128.toString(),
        useFullPrecision: true
    });

    const idealAmount0 = BigInt(mockPosition.mintAmounts.amount0.toString());
    const idealAmount1 = BigInt(mockPosition.mintAmounts.amount1.toString());

    // Handle Single-Sided Ranges (Price is outside or on the edge)
    if (idealAmount0 === 0n) {
        console.log("   [SmartSwap] Range requires 100% Token1. Swapping all Token0...");
    } else if (idealAmount1 === 0n) {
        console.log("   [SmartSwap] Range requires 100% Token0. Swapping all Token1...");
    }

    // 2. Calculate Total Portfolio Value in terms of Token1 (usually USDC if Token1 is USDC)
    // This helps us determine how much of the total value should be in Token0 vs Token1
    // Note: This is an estimation.
    
    // Current Balances
    const currentAmount0 = configuredPool.token0.address === WETH_TOKEN.address ? balWETH : balUSDC;
    const currentAmount1 = configuredPool.token1.address === WETH_TOKEN.address ? balWETH : balUSDC;

    // Convert to Human-Readable numbers for calculation to avoid Unit mixing bugs
    const bal0 = parseFloat(ethers.formatUnits(currentAmount0, configuredPool.token0.decimals));
    const bal1 = parseFloat(ethers.formatUnits(currentAmount1, configuredPool.token1.decimals));

    // Price of Token0 in terms of Token1 (e.g. 2600 USDC per ETH)
    const price0 = parseFloat(configuredPool.token0Price.toFixed(10));
    
    // Total Portfolio Value in Token1 terms
    const totalValue = bal1 + (bal0 * price0);

    const router = new ethers.Contract(SWAP_ROUTER_ADDR, SWAP_ROUTER_ABI, wallet);
    const quoter = new ethers.Contract(QUOTER_ADDR, QUOTER_ABI, wallet);

    // Slippage Helper
    const calculateMinOut = (quotedAmount: bigint) => {
        const tolerance = BigInt(SLIPPAGE_TOLERANCE.numerator.toString());
        const basis = BigInt(SLIPPAGE_TOLERANCE.denominator.toString());
        return quotedAmount * (basis - tolerance) / basis;
    };

    // 3. Calculate Target Amounts based on Ideal Ratio (Human Readable)
    const ideal0Raw = BigInt(mockPosition.mintAmounts.amount0.toString());
    const ideal1Raw = BigInt(mockPosition.mintAmounts.amount1.toString());
    
    const ideal0 = parseFloat(ethers.formatUnits(ideal0Raw, configuredPool.token0.decimals));
    const ideal1 = parseFloat(ethers.formatUnits(ideal1Raw, configuredPool.token1.decimals));
    
    let ratio = 0;
    if (ideal0 === 0) ratio = Infinity; // Pure Token1 needed
    else ratio = ideal1 / ideal0;
    
    // Target Amount0 formula: Value = T0 * Price + T0 * Ratio
    let target0 = 0;
    if (ratio === Infinity) target0 = 0;
    else target0 = totalValue / (price0 + ratio);

    // Convert Target back to Raw BigInt
    // Use toFixed to avoid scientific notation issues with parseUnits
    const targetAmount0 = ethers.parseUnits(target0.toFixed(configuredPool.token0.decimals), configuredPool.token0.decimals);

    // 4. Determine Swap Direction
    if (currentAmount0 > targetAmount0) {
        // We have too much Token0 (e.g. WETH), sell difference for Token1 (USDC)
        const amountToSellRaw = currentAmount0 - targetAmount0;
        const amountToSell = CurrencyAmount.fromRawAmount(configuredPool.token0, amountToSellRaw.toString());

        // Threshold check (approximate based on token type)
        const threshold = configuredPool.token0.address === USDC_TOKEN.address ? REBALANCE_THRESHOLD_USDC : REBALANCE_THRESHOLD_WETH;
        
        if (amountToSellRaw < threshold) {
            console.log("   Balance is good enough. Skipping swap.");
            return;
        }
    
        const amountIn = BigInt(amountToSell.quotient.toString());
        console.log(`   [Swap] Selling ${amountToSell.toSignificant(6)} ${configuredPool.token0.symbol} for ${configuredPool.token1.symbol}`);

        // 1. Quote
        const quoteParams = {
            tokenIn: configuredPool.token0.address,
            tokenOut: configuredPool.token1.address,
            amountIn: amountIn,
            fee: POOL_FEE,
            sqrtPriceLimitX96: 0
        };
        // QuoterV2 returns struct, ethers v6 parses it. First return value is amountOut.
        const [quotedAmountOut] = await quoter.getFunction("quoteExactInputSingle").staticCall(quoteParams);
        const amountOutMin = calculateMinOut(quotedAmountOut);

        console.log(`   [Quote] Expect: ${ethers.formatUnits(quotedAmountOut, configuredPool.token1.decimals)} ${configuredPool.token1.symbol}`);

       const tx = await router.exactInputSingle({
            tokenIn: configuredPool.token0.address,
            tokenOut: configuredPool.token1.address,
            fee: POOL_FEE,
            recipient: wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 120,
            amountIn: amountIn,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0,
        });

        await waitWithTimeout(tx, TX_TIMEOUT_MS);
    } else {
        const target1 = totalValue - (target0 * price0);
        const targetAmount1 = ethers.parseUnits(target1.toFixed(configuredPool.token1.decimals), configuredPool.token1.decimals);
        
        if (currentAmount1 <= targetAmount1) {
             console.log("   Balance is good enough (or deficit is negligible). Skipping swap.");
             return;
        }

        const amountToSellRaw = currentAmount1 - targetAmount1;
        const amountToSell = CurrencyAmount.fromRawAmount(configuredPool.token1, amountToSellRaw.toString());

        const threshold = configuredPool.token1.address === USDC_TOKEN.address ? REBALANCE_THRESHOLD_USDC : REBALANCE_THRESHOLD_WETH;
        
        if (amountToSellRaw < threshold) {
            console.log("   Balance is good enough. Skipping swap.");
            return;
        }

       const amountIn = BigInt(amountToSell.quotient.toString());
        console.log(`   [Swap] Selling ${amountToSell.toSignificant(6)} ${configuredPool.token1.symbol} for ${configuredPool.token0.symbol}`);

        // 1. Quote
        const quoteParams = {
            tokenIn: configuredPool.token1.address,
            tokenOut: configuredPool.token0.address,
            amountIn: amountIn,
            fee: POOL_FEE,
            sqrtPriceLimitX96: 0
        };
        const [quotedAmountOut] = await quoter.getFunction("quoteExactInputSingle").staticCall(quoteParams);
        const amountOutMin = calculateMinOut(quotedAmountOut);

        console.log(`   [Quote] Expect: ${ethers.formatUnits(quotedAmountOut, configuredPool.token0.decimals)} ${configuredPool.token0.symbol}`);

        const tx = await router.exactInputSingle({
            tokenIn: configuredPool.token1.address,
            tokenOut: configuredPool.token0.address,
            fee: POOL_FEE,
            recipient: wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 120,
            amountIn: amountIn,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0,
        });

        await waitWithTimeout(tx, TX_TIMEOUT_MS);
    }
}

export async function mintMaxLiquidity(
    wallet: ethers.Wallet,
    configuredPool: Pool,
    tickLower: number,
    tickUpper: number
): Promise<string> {
    const balUSDC = await getBalance(USDC_TOKEN, wallet);
    const balWETH = await getBalance(WETH_TOKEN, wallet);

    const amount0Input =
        configuredPool.token0.address === WETH_TOKEN.address
            ? balWETH
            : balUSDC;
    const amount1Input =
        configuredPool.token1.address === WETH_TOKEN.address
            ? balWETH
            : balUSDC;

    // [Optimized] 99% Buffer (was 99.9%)
    // Lowered to 99% to prevent "Transfer amount exceeds balance" errors due to 
    // tiny dust issues or RPC balance sync lags.
    const amount0Safe = (amount0Input * 990n) / 1000n;
    const amount1Safe = (amount1Input * 990n) / 1000n;

    const position = Position.fromAmounts({
        pool: configuredPool,
        tickLower,
        tickUpper,
        amount0: amount0Safe.toString(),
        amount1: amount1Safe.toString(),
        useFullPrecision: true,
    });

    const { amount0: amount0Min, amount1: amount1Min } =
        position.mintAmountsWithSlippage(SLIPPAGE_TOLERANCE);

    const mintParams = {
        token0: configuredPool.token0.address,
        token1: configuredPool.token1.address,
        fee: POOL_FEE,
        tickLower,
        tickUpper,
        amount0Desired: position.mintAmounts.amount0.toString(),
        amount1Desired: position.mintAmounts.amount1.toString(),

        amount0Min: amount0Min.toString(),
        amount1Min: amount1Min.toString(),

        recipient: wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 120,
    };

    // [Safety] Check for Zero Amounts to prevent Reverts
    if (BigInt(mintParams.amount0Desired) === 0n && BigInt(mintParams.amount1Desired) === 0n) {
        console.warn(`[Mint] Aborting: Calculated mint amounts are ZERO. (Check WETH/USDC balances)`);
        return "0";
    }

    console.log(`\n[Mint] Minting new position...`);
    console.log(`   [Mint] Desired: ${position.mintAmounts.amount0.toString()} / ${position.mintAmounts.amount1.toString()}`);
    console.log(`   [Mint] Min: ${amount0Min.toString()} / ${amount1Min.toString()}`);
    const npm = new ethers.Contract(
        NONFUNGIBLE_POSITION_MANAGER_ADDR,
        NPM_ABI,
        wallet
    );
    const tx = await npm.mint(mintParams, { gasLimit: 1_000_000 });
    const receipt = await waitWithTimeout(tx, TX_TIMEOUT_MS);

    const transferEventSig = ethers.id("Transfer(address,address,uint256)");

    const transferLog = receipt.logs.find((log: any) => {
        if (log.topics[0] !== transferEventSig) return false;

        try {
            const toAddress = ethers.dataSlice(log.topics[2], 12); 
            return ethers.getAddress(toAddress) === wallet.address;
        } catch {
            return false;
        }
    });

    if (!transferLog) {
        throw new Error(
            "Mint successful but failed to parse Token ID from logs (Transfer event not found)."
        );
    }

    const newTokenId = BigInt(transferLog.topics[3]).toString();

    console.log(`   Success! Token ID: ${newTokenId}`);
    return newTokenId;
}

export async function swapAllWethToUsdc(wallet: ethers.Wallet) {
    console.log(`\n[CircuitBreaker] Swapping all remaining WETH to USDC...`);
    const balWETH = await getBalance(WETH_TOKEN, wallet);

    if (balWETH < REBALANCE_THRESHOLD_WETH) { // Use a threshold to avoid dust swaps
        console.log(`   Negligible WETH balance. Skipping swap.`);
        return;
    }

    const router = new ethers.Contract(SWAP_ROUTER_ADDR, SWAP_ROUTER_ABI, wallet);
    const quoter = new ethers.Contract(QUOTER_ADDR, QUOTER_ABI, wallet);

    // Quote
    const quoteParams = {
        tokenIn: WETH_TOKEN.address,
        tokenOut: USDC_TOKEN.address,
        amountIn: balWETH,
        fee: POOL_FEE,
        sqrtPriceLimitX96: 0
    };
    const [quotedAmountOut] = await quoter.getFunction("quoteExactInputSingle").staticCall(quoteParams);
    
    // Slippage
    const tolerance = BigInt(SLIPPAGE_TOLERANCE.numerator.toString());
    const basis = BigInt(SLIPPAGE_TOLERANCE.denominator.toString());
    const amountOutMin = quotedAmountOut * (basis - tolerance) / basis;

    console.log(`   [Swap] Selling ${ethers.formatEther(balWETH)} WETH for ~${ethers.formatUnits(quotedAmountOut, 6)} USDC.`);

    const tx = await router.exactInputSingle({
        tokenIn: WETH_TOKEN.address,
        tokenOut: USDC_TOKEN.address,
        fee: POOL_FEE,
        recipient: wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 120,
        amountIn: balWETH,
        amountOutMinimum: amountOutMin,
        sqrtPriceLimitX96: 0,
    });

    await waitWithTimeout(tx, TX_TIMEOUT_MS);
    console.log(`   Swap to USDC complete.`);
}

// Full Rebalancing Process: Remove Old -> Swap -> Refresh Price -> Mint New
export async function executeFullRebalance(
    wallet: ethers.Wallet,
    configuredPool: Pool,
    oldTokenId: string
) {
    console.log(`[Rebalance] Starting full rebalance sequence...`);

    // 0. TWAP Price Safety Check
    // Prevents price manipulation via flash loans from triggering a rebalance at a bad price.
    const poolAddr = Pool.getAddress(USDC_TOKEN, WETH_TOKEN, POOL_FEE, undefined, V3_FACTORY_ADDR);
    const poolContract = new ethers.Contract(poolAddr, POOL_ABI, wallet);

    try {
        // Get TWAP Tick for the last 5 minutes (300 seconds)
        const twapTick = Number(await getPoolTwap(poolContract, 300));
        const currentTick = configuredPool.tickCurrent;
        
        // Calculate tick difference
        const tickDiff = Math.abs(currentTick - twapTick);
        
        // 1% price deviation is roughly 100 ticks (Basis Points)
        // Threshold: If Spot deviates from TWAP by more than 200 ticks (~2%), reject the trade.
        const MAX_TICK_DEVIATION = 200; 

        console.log(`   [Safety] Spot Tick: ${currentTick} | TWAP Tick: ${twapTick} | Diff: ${tickDiff}`);

        if (tickDiff > MAX_TICK_DEVIATION) {
            const msg = `Price manipulation detected! Spot price deviates from TWAP by ${tickDiff} ticks.`;
            await sendEmailAlert("TWAP Check Failed", msg);
            throw new Error(`Price manipulation detected! Spot price deviates from TWAP by ${tickDiff} ticks.`);
        }
    } catch (e) {
        console.error("   [Safety] TWAP check failed:", e);
        await sendEmailAlert("TWAP Check Error", `Error checking TWAP: ${e}`);
        throw e; // Must throw exception to stop further operations
    }

    
    console.log("   [Strategy] Pre-fetching market analytics...");
    let atr, rsi;
    try {
        [atr, rsi] = await Promise.all([
            getEthAtr("15m"),
            getEthRsi("15m")
        ]);
        console.log(`   [Strategy] Data acquired. ATR: ${atr}, RSI: ${rsi}`);
    } catch (e) {
        console.error("   [Strategy] Failed to fetch market data. Aborting rebalance to keep old position safe.");
        throw e; // keep old position
    }

    // 1. Exit Old Position
    let exitInfo = { amount0: 0n, amount1: 0n };
    if (oldTokenId !== "0") {
        exitInfo = await atomicExitPosition(wallet, oldTokenId);
    }

    console.log("   [System] Refreshing market data...");

    // 2. Refresh Data (Fetch latest Price/Liquidity)
    const [newSlot0, newLiquidity] = await Promise.all([
        poolContract.slot0(),
        poolContract.liquidity(),
    ]);

    const newCurrentTick = Number(newSlot0.tick);

    const freshPool = new Pool(
        USDC_TOKEN,
        WETH_TOKEN,
        POOL_FEE,
        newSlot0.sqrtPriceX96.toString(),
        newLiquidity.toString(),
        newCurrentTick
    );

    console.log(`   [Update] Tick: ${newCurrentTick}`);

    // ============================================================
    // DYNAMIC RANGE CALCULATION (ATR + RSI SKEW)
    // ============================================================

    const priceStr =
        freshPool.token0.address === WETH_TOKEN.address
            ? freshPool.token0Price.toSignificant(6)
            : freshPool.token1Price.toSignificant(6);
    const currentPrice = parseFloat(priceStr);

    const volPercent = (atr / currentPrice) * 100;

    let dynamicWidth = Math.floor(volPercent * 100 * ATR_SAFETY_FACTOR);

    console.log(
        `   [Strategy] ATR: $${atr.toFixed(2)} | Vol: ${volPercent.toFixed(2)}% | Calc Width: ${dynamicWidth}`
    );

    // [Optimization] Increased floor to 200 to prevent over-trading.
    // 200 ticks radius = +/- 2% range.
    const WIDTH = Math.max(200, Math.min(dynamicWidth, 4000)); 

    console.log(`   [Strategy] Base Radius Width: ${WIDTH}`);

    const tickSpace = freshPool.tickSpacing;
    const MIN_TICK = -887272;
    const MAX_TICK = 887272;


    let skew = 0.5;

    if (rsi > 75) {
        skew = 0.3;
        console.log(`   [Strategy] RSI High -> Skewing Range DOWN (Bearish Setup)`);
    } else if (rsi < 25) {
        skew = 0.7;
        console.log(`   [Strategy] RSI Low -> Skewing Range UP (Bullish Setup)`);
    } else {
        console.log(`   [Strategy] RSI Neutral -> Symmetric Range`);
    }

    const totalSpan = WIDTH * 2;

    const upperTickDiff = Math.floor(totalSpan * skew);
    const lowerTickDiff = Math.floor(totalSpan * (1 - skew));

    let tickLower =
        Math.floor((newCurrentTick - lowerTickDiff) / tickSpace) * tickSpace;
    let tickUpper =
        Math.floor((newCurrentTick + upperTickDiff) / tickSpace) * tickSpace;

    if (tickLower < MIN_TICK)
        tickLower = Math.ceil(MIN_TICK / tickSpace) * tickSpace;
    if (tickUpper > MAX_TICK)
        tickUpper = Math.floor(MAX_TICK / tickSpace) * tickSpace;

    if (tickLower >= tickUpper) {
        tickUpper = tickLower + tickSpace;
    }

    if (tickUpper > MAX_TICK) {
        tickUpper = Math.floor(MAX_TICK / tickSpace) * tickSpace;
        tickLower = tickUpper - tickSpace;
    }

    console.log(
        `   New Range: [${tickLower}, ${tickUpper}] (Skew: ${skew}, Span: ${
            tickUpper - tickLower
        })`
    );

    // 3. Smart Swap (Swap only what is needed for the NEW range)
    try {
        await smartRebalance(wallet, freshPool, tickLower, tickUpper);
    } catch (e) {
        console.error("   [Rebalance] Swap failed:", e);
        await sendEmailAlert("Rebalance Swap Failed", `Swap likely reverted due to Slippage or Gas: ${e}`);
        throw e; 
    }

    // [Safety] Wait 2 seconds for RPC nodes to sync the new balances after the Swap.
    // This prevents Mint from failing due to reading old (insufficient) balances.
    console.log("   [System] Waiting 2s for balance sync...");
    await sleep(2000);

    // [Analysis] Calculate Portfolio Value BEFORE Minting (Raw Tokens)
    // This gives us the most accurate "Net Worth" snapshot.
    const [balUSDC, balWETH] = await Promise.all([
        getBalance(USDC_TOKEN, wallet),
        getBalance(WETH_TOKEN, wallet)
    ]);

    const token0 = freshPool.token0;
    const token1 = freshPool.token1;
    
    // Determine ETH Price in USD
    // If Token0 is WETH, price is USDC/WETH. If Token1 is WETH, price is USDC/WETH.
    // We assume the other token is USDC.
    const ethPrice = (token0.symbol?.includes('ETH')) 
        ? parseFloat(freshPool.token0Price.toSignificant(6))
        : parseFloat(freshPool.token1Price.toSignificant(6));

    const valEth = parseFloat(ethers.formatUnits(balWETH, 18)) * ethPrice;
    const valUsdc = parseFloat(ethers.formatUnits(balUSDC, 6));
    const totalValueUsd = valEth + valUsdc;

    // [Fix] Refresh pool state before minting.
    // Price moves during the sleep/swap. Using old 'freshPool' data causes
    // 'Price slippage check' reverts because amountMin is calculated on stale data.
    const [finalSlot0, finalLiquidity] = await Promise.all([
        poolContract.slot0(),
        poolContract.liquidity(),
    ]);

    const finalPool = new Pool(
        USDC_TOKEN,
        WETH_TOKEN,
        POOL_FEE,
        finalSlot0.sqrtPriceX96.toString(),
        finalLiquidity.toString(),
        Number(finalSlot0.tick)
    );

    // 4. Mint
    const newTokenId = await mintMaxLiquidity(
        wallet,
        finalPool, // Use the latest pool state
        tickLower,
        tickUpper
    );
    
    if (newTokenId !== "0") {
        saveState(newTokenId);
        
        // Format Human-Readable Report
        const exit0 = parseFloat(ethers.formatUnits(exitInfo.amount0, token0.decimals)).toFixed(4);
        const exit1 = parseFloat(ethers.formatUnits(exitInfo.amount1, token1.decimals)).toFixed(2);
        
        const msg = `
Strategy Rebalanced Successfully!

[Old Position Exit]
ID: ${oldTokenId}
Collected: ${exit0} ${token0.symbol} + ${exit1} ${token1.symbol}

[New Position Entry]
ID: ${newTokenId}
Range: [${tickLower}, ${tickUpper}]
Current Price: $${ethPrice.toFixed(2)}

[Portfolio Snapshot]
Total Value: $${totalValueUsd.toFixed(2)}
Held: ${parseFloat(ethers.formatUnits(balWETH, 18)).toFixed(4)} WETH + ${parseFloat(ethers.formatUnits(balUSDC, 6)).toFixed(2)} USDC
        `.trim();

        await sendEmailAlert(
            `Rebalance Success - $${totalValueUsd.toFixed(0)}`,
            msg
        );
    } else {
        console.warn("[Strategy] Mint returned 0 ID. Keeping state as is (or 0).");
    }
}