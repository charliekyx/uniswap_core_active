import { ethers } from "ethers";

import * as nodemailer from "nodemailer";

import { MAX_RETRIES } from "../config";

// Get Uniswap V3 TWAP (Time-Weighted Average Price)
// Returns the time-weighted average tick for the specified interval.
export async function getPoolTwap(
    poolContract: ethers.Contract,
    twapInterval: number = 300, // Default: 5 minutes (300 seconds)
): Promise<bigint> {
    // observe takes an array of secondsAgos: [twapInterval, 0]
    // Returns corresponding tickCumulatives
    const [tickCumulatives] = await poolContract.observe([twapInterval, 0]);

    const tickCumulativeBefore = BigInt(tickCumulatives[0]);
    const tickCumulativeNow = BigInt(tickCumulatives[1]);

    // Average Tick = (TickCumulative_Now - TickCumulative_Before) / TimeInterval
    const timeWeightedAverageTick = Number(
        (tickCumulativeNow - tickCumulativeBefore) / BigInt(twapInterval),
    );

    // Return the tick directly for easier comparison
    return BigInt(Math.floor(timeWeightedAverageTick));
}

export function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(operation: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (retries > 0) {
            const delay = 1000 * (MAX_RETRIES - retries + 1);
            console.warn(`[Network] Request failed. Retrying in ${delay}ms... (${retries} left)`);
            await sleep(delay);
            return withRetry(operation, retries - 1);
        }
        throw error;
    }
}

export async function waitWithTimeout(
    tx: ethers.ContractTransactionResponse,
    timeoutMs: number,
): Promise<ethers.ContractTransactionReceipt> {
    console.log(`[Tx] Waiting for confirmation: ${tx.hash}`);

    const receipt = await Promise.race([
        tx.wait(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs)),
    ]);

    if (!receipt) throw new Error("Tx dropped or failed");

    // 2. Cast the result as the correct type
    return receipt as ethers.ContractTransactionReceipt;
}

const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || "gmail",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

export async function sendEmailAlert(subject: string, text: string) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.log("[Email] No credentials found. Skipping alert.");
        return;
    }

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_TO,
        subject: `[UNISWAP_ACIVE] ${subject}`,
        text: text,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`[Email] Sent: ${subject}`);
    } catch (error) {
        console.error("[Email] Failed to send:", error);
    }
}
