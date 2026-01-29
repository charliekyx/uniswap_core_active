import { ethers, NonceManager } from "ethers";
import { Pool } from "@uniswap/v3-sdk";
import * as dotenv from "dotenv";

import {
    USDC_TOKEN,
    WETH_TOKEN,
    POOL_FEE,
    POOL_ABI,
    NPM_ABI,
    NONFUNGIBLE_POSITION_MANAGER_ADDR,
    V3_FACTORY_ADDR,
    BASE_BUFFER_FACTOR,
    ATR_BUFFER_SCALING,
    CIRCUIT_BREAKER_DEVIATION_FACTOR,
} from "./config";

import { loadState, saveState, scanLocalOrphans } from "./src/state"; // [Added] scanLocalOrphans
import {
    approveAll,
    executeFullRebalance,
    atomicExitPosition,
    swapAllWethToUsdc,
} from "./src/actions";
import { RobustProvider } from "./src/connection";
import { sendEmailAlert } from "./src/utils";
import { logAction } from "./src/logger";
import { getEthAtr } from "./src/analytics";

dotenv.config();

let wallet: ethers.Wallet;
let provider: ethers.Provider;
let robustProvider: RobustProvider;
let npm: ethers.Contract;
let poolContract: ethers.Contract;
let isProcessing = false;

// Safe Mode Flag
let isSafeMode = false;

// Last run timestamp for block listener throttling
let lastRunTime = 0;
const MIN_INTERVAL_MS = 3000; // 3s

// [State] Dynamic Buffer Caching
let cachedAtr = 0;
let lastAtrUpdate = 0;

async function initialize() {
    const rpcEnv = process.env.RPC_URL || "";
    const rpcUrls = rpcEnv
        .split(",")
        .map((u) => u.trim())
        .filter((u) => u.length > 0);

    if (rpcUrls.length === 0) {
        throw new Error("RPC_URL is not set in .env");
    }

    console.log(`[System] Loaded ${rpcUrls.length} RPC nodes.`);

    // Initialize Robust WebSocket Provider with Fallback
    robustProvider = new RobustProvider(rpcUrls, async () => {
        console.log("[System] Provider switched/reconnected. Re-binding events...");

        provider = robustProvider.getProvider();

        // [Important] Wallet also needs to reconnect to the new Provider, otherwise transactions will fail with Network Error
        // Note: Since wallet is a global variable, we need to update its provider
        const newWallet = wallet.connect(provider);

        const userAddress = await newWallet.getAddress();
        (newWallet as any).address = userAddress;

        wallet = newWallet as any;

        poolContract = poolContract.connect(provider) as ethers.Contract;
        npm = npm.connect(wallet) as ethers.Contract;

        console.log("[System] Contracts and Managers re-linked to new provider.");

        await setupEventListeners();
    });

    provider = robustProvider.getProvider();

    // [Note] When initializing wallet here
    const baseWallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
    const managedWallet = new NonceManager(baseWallet);
    (managedWallet as any).address = baseWallet.address;
    wallet = managedWallet as any;

    console.log(`[System] Wallet initialized: ${await wallet.getAddress()}`);

    const poolAddr = Pool.getAddress(USDC_TOKEN, WETH_TOKEN, POOL_FEE, undefined, V3_FACTORY_ADDR);
    poolContract = new ethers.Contract(poolAddr, POOL_ABI, provider);
    npm = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI, wallet);

    console.log(`[System] Initialized.`);
    logAction(0, "INFO", "0", 0, "System Initialized/Restarted");

    await approveAll(wallet);

    // Orphan Position Scanning
    // If local state is 0 but on-chain position exists, sync state.
    const state = loadState();
    if (state.tokenId === "0") {
        await scanLocalOrphans(wallet);
    }

    await setupEventListeners();
}

async function setupEventListeners() {
    provider.removeAllListeners();
    console.log("[System] Listening for blocks...");

    provider.on("block", async (blockNumber) => {
        // Safe Mode Check
        if (isSafeMode) {
            if (blockNumber % 100 === 0) {
                // Reduce log noise
                console.warn(
                    `[SafeMode] Bot is in SAFE MODE. No actions taken. Block: ${blockNumber}`,
                );
            }
            return;
        }

        if (isProcessing) return;
        isProcessing = true;

        const now = Date.now();

        if (now - lastRunTime < MIN_INTERVAL_MS) {
            console.log("[rpc limit]: skip less than");
            return;
        }

        try {
            lastRunTime = now;
            await onNewBlock(blockNumber);
        } catch (e: any) {
            console.error(`[Block ${blockNumber}] Error:`, e);

            // Auto-switch provider on network/rate-limit errors
            const errStr = e.toString().toLowerCase();
            if (
                errStr.includes("too many requests") ||
                errStr.includes("429") ||
                errStr.includes("bad_data") ||
                errStr.includes("timeout")
            ) {
                console.warn(`[System] RPC Instability detected. Switching provider...`);
                await robustProvider.triggerNextProvider();
            }
        } finally {
            isProcessing = false;
        }
    });
}

async function onNewBlock(blockNumber: number) {
    const { tokenId } = await loadState();

    if (!tokenId || tokenId === "0") {
        console.log(`[Block ${blockNumber}] No active position. Initializing Strategy...`);

        // ... Fetch Pool Data ...
        const [slot0, liquidity] = await Promise.all([
            poolContract.slot0(),
            poolContract.liquidity(),
        ]);

        const configuredPool = new Pool(
            USDC_TOKEN,
            WETH_TOKEN,
            POOL_FEE,
            slot0.sqrtPriceX96.toString(),
            liquidity.toString(),
            Number(slot0.tick),
        );

        const price = configuredPool.token0Price.toSignificant(6);
        logAction(
            blockNumber,
            "ENTRY",
            price,
            Number(slot0.tick),
            "No active position. Attempting Entry.",
        );

        // If executeFullRebalance throws (e.g. TWAP check failed), catch it here
        // protects app from crashing, waits for next block retry.
        try {
            await executeFullRebalance(wallet, configuredPool, "0", blockNumber);
            logAction(blockNumber, "INFO", price, Number(slot0.tick), "Entry execution sent.");
        } catch (e) {
            // This is the "Judging" phase. If TWAP fails, we wait.
            console.warn(
                `[Strategy] Auto-reentry skipped: ${(e as any).message}. Waiting for market stability...`,
            );
            logAction(
                blockNumber,
                "ERROR",
                price,
                Number(slot0.tick),
                `Entry skipped: ${(e as any).message}`,
            );
        }

        return;
    }

    // ============================================================
    // STRATEGY PATH
    // ============================================================

    console.log(`[Block ${blockNumber}] Running Strategy Logic...`);

    const [slot0, liquidity] = await Promise.all([poolContract.slot0(), poolContract.liquidity()]);

    const currentTick = Number(slot0.tick);
    const configuredPool = new Pool(
        USDC_TOKEN,
        WETH_TOKEN,
        POOL_FEE,
        slot0.sqrtPriceX96.toString(),
        liquidity.toString(),
        currentTick,
    );

    const currentPrice = configuredPool.token0Price.toSignificant(6);

    const pos = await npm.positions(tokenId);
    if (pos.liquidity === 0n) {
        await sendEmailAlert("CRITICAL: Position Closed.", `ID: ${tokenId}`);
        // Mark as orphan or reset
        const foundId = await scanLocalOrphans(wallet);
        if (foundId === "0") {
            console.log(
                "[System] No orphan position found. Resetting state to 0 to trigger new entry.",
            );
            saveState("0");
        }
        logAction(
            blockNumber,
            "ERROR",
            currentPrice,
            currentTick,
            "Position found closed/liquidated externally.",
        );
        return null;
    }

    const tl = Number(pos.tickLower);
    const tu = Number(pos.tickUpper);

    // [New] Circuit Breaker / Stop-Loss Logic
    const positionWidth = tu - tl;
    const centerTick = (tl + tu) / 2;
    const distanceFromCenter = Math.abs(currentTick - centerTick);
    const stopLossThreshold = positionWidth * CIRCUIT_BREAKER_DEVIATION_FACTOR;

    if (distanceFromCenter > stopLossThreshold) {
        console.warn(
            `[CIRCUIT BREAKER] Price has moved significantly (${distanceFromCenter} ticks) away from position center. Triggering stop-loss.`,
        );
        await sendEmailAlert(
            "CIRCUIT BREAKER TRIGGERED",
            `Price moved ${distanceFromCenter} ticks from range center. Exiting to USDC.`,
        );
        logAction(
            blockNumber,
            "STOP_LOSS",
            currentPrice,
            currentTick,
            `Circuit Breaker! Dist: ${distanceFromCenter}, Threshold: ${stopLossThreshold}`,
        );

        // 1. Exit position
        await atomicExitPosition(wallet, tokenId);

        // 2. Swap all WETH to USDC
        await swapAllWethToUsdc(wallet);

        // 3. Clear state and enter safe mode
        saveState("0");
        console.warn(
            `[CIRCUIT BREAKER] Position closed. Bot will continue running and attempt to re-enter when market conditions stabilize.`,
        );
        return;
    }

    // [Optimized] Dynamic Hysteresis Buffer
    // Only rebalance if price is SIGNIFICANTLY out of range.
    // This prevents realizing IL on small wicks/noise.
    
    // 1. Update Volatility (ATR) every 5 minutes
    if (Date.now() - lastAtrUpdate > 5 * 60 * 1000) {
        try {
            cachedAtr = await getEthAtr("15m");
            lastAtrUpdate = Date.now();
            console.log(`[System] Updated Market Volatility (ATR 15m): ${cachedAtr}`);
        } catch (e) {
            console.warn(`[System] Failed to update ATR for buffer: ${(e as any).message}`);
        }
    }

    // 2. Calculate Dynamic Factor based on Volatility
    let bufferFactor = 0.3; // Fallback default
    const priceVal = parseFloat(currentPrice);
    
    if (cachedAtr > 0 && priceVal > 0) {
        const volPercent = cachedAtr / priceVal; // e.g. 0.005 (0.5%)
        bufferFactor = BASE_BUFFER_FACTOR + (volPercent * ATR_BUFFER_SCALING);
    }
    // Clamp buffer between 0.1 (10%) and 0.8 (80%)
    bufferFactor = Math.max(0.1, Math.min(bufferFactor, 0.8));

    const dynamicBufferTicks = Math.floor(positionWidth * bufferFactor);
    console.log(`   [Safety] Vol: ${(cachedAtr/priceVal*100).toFixed(2)}% | Factor: ${bufferFactor.toFixed(2)} | Buffer Ticks: ${dynamicBufferTicks}`);

    if (currentTick < tl - dynamicBufferTicks || currentTick > tu + dynamicBufferTicks) {
        console.log(`[Strategy] Out of Range. Rebalancing...`);
        logAction(
            blockNumber,
            "REBALANCE",
            currentPrice,
            currentTick,
            `Out of range. Old Range: [${tl}, ${tu}]`,
        );
        await executeFullRebalance(wallet, configuredPool, tokenId, blockNumber);
        return;
    }
}

initialize().catch(console.error);
