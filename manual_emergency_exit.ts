import * as dotenv from "dotenv";
import { ethers } from "ethers";
import { loadState, saveState } from "./src/state";
import { atomicExitPosition, swapAllWethToUsdc } from "./src/actions";

dotenv.config();

async function main() {
    console.log("[Emergency] 正在启动手动紧急退出程序...");

    // 1. 初始化 Provider 和 Wallet
    const rpcEnv = process.env.RPC_URL || "";
    const rpcUrls = rpcEnv.split(",").map((u) => u.trim()).filter((u) => u.length > 0);

    if (rpcUrls.length === 0) {
        throw new Error("RPC_URL 未在 .env 文件中设置");
    }

    // 使用配置中的第一个 RPC 节点
    const provider = new ethers.JsonRpcProvider(rpcUrls[0]);
    
    if (!process.env.PRIVATE_KEY) {
        throw new Error("PRIVATE_KEY 未在 .env 文件中设置");
    }
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    console.log(`操作钱包地址: ${wallet.address}`);

    // 2. 获取当前持仓状态
    let tokenId = "0";
    try {
        const state = loadState();
        tokenId = state.tokenId;
        console.log(`当前记录的持仓 Token ID: ${tokenId}`);
    } catch (e) {
        console.warn("无法读取状态文件，默认为无持仓 (0)。");
    }

    // 3. 执行平仓 (Close LP)
    if (tokenId && tokenId !== "0") {
        console.log(`发现活跃持仓 (ID: ${tokenId})，正在执行强制平仓...`);
        try {
            // 调用 actions.ts 中的原子退出函数
            await atomicExitPosition(wallet, tokenId);
            console.log("平仓成功！");
        } catch (e) {
            console.error("平仓失败:", e);
            console.log("即使平仓失败，程序仍将尝试执行 WETH -> USDC 兑换...");
        }
    } else {
        console.log("未发现活跃 LP 持仓，跳过平仓步骤。");
    }

    // 4. 将所有 WETH 兑换为 USDC
    console.log("💱 正在将钱包内所有 WETH 兑换为 USDC...");
    try {
        await swapAllWethToUsdc(wallet);
        console.log("兑换流程结束 (或余额不足无需兑换)。");
    } catch (e) {
        console.error("兑换失败:", e);
    }

    // 5. 重置本地状态
    console.log("重置本地状态为 0...");
    saveState("0");

    console.log("紧急退出脚本执行完毕。");
}

main().catch((e) => {
    console.error("脚本执行出错:", e);
    process.exit(1);
});
