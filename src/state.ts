import * as fs from "fs";

import * as path from "path";

import { ethers } from "ethers";

import { NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI } from "../config";


const STATE_FILE = path.join(process.cwd(), "bot_state.json");

export interface BotState {
    tokenId: string; // tokenid from my last postion mint
    lastCheck: number;
}

export function loadState(): BotState {
    if (fs.existsSync(STATE_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        } catch (e) {
            console.error("[System] Corrupt state file. Resetting.");
        }
    }
    return { tokenId: "0", lastCheck: 0 };
}

export function saveState(tokenId: string) {
    const state: BotState = { tokenId, lastCheck: Date.now() };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`[System] State saved: Token ID ${tokenId}`);
}

// Orphan Position Scanning
// Checks if the wallet holds any NFTs while the local state says "0".
// This fixes race conditions where state save fails after minting.
export async function scanLocalOrphans(wallet: ethers.Wallet): Promise<string> {
    console.log("[State] Scanning for orphan positions...");
    const npm = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI, wallet);
    
    const balance = await npm.balanceOf(wallet.address);
    if (balance === 0n) {
        console.log("[State] No on-chain positions found.");
        return "0";
    }

    // Simple strategy: Check the last NFT owned by the wallet
    // If running multiple bots/strategies, this logic needs to be more complex
    // Right now it only manages one wallet
    const idx = balance - 1n; 
    const tokenId = await npm.tokenOfOwnerByIndex(wallet.address, idx);
    
    const pos = await npm.positions(tokenId);
    
    if (pos.liquidity > 0n) {
        console.warn(`[State] FOUND ORPHAN POSITION: ID ${tokenId} (Liq: ${pos.liquidity})`);
        console.warn(`[State] Adopting this position and updating state file.`);
        saveState(tokenId.toString());
        return tokenId.toString();
    }

    return "0";
}
