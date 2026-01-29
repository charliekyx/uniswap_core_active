import * as fs from "fs";
import * as path from "path";

// 日志目录和文件路径
// 在 Docker 中 process.cwd() 通常是 /app
const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "trade_history.csv");

// 初始化：如果文件不存在，创建并写入表头
function initLogger() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    if (!fs.existsSync(LOG_FILE)) {
        // CSV 表头：时间, 区块高度, 类型, 价格(USDC/ETH), Tick, 详情
        const header = "Timestamp,Block,Type,Price,Tick,Details\n";
        fs.writeFileSync(LOG_FILE, header);
    }
}

initLogger();

export function logAction(
    blockNumber: number,
    type: "ENTRY" | "REBALANCE" | "STOP_LOSS" | "ERROR" | "INFO" | "STRATEGY_METRICS",
    price: string,
    tick: number,
    details: string,
) {
    const timestamp = new Date().toISOString();
    // 移除详情中的英文逗号和引号，防止破坏 CSV 格式
    const safeDetails = details.replace(/,/g, ";").replace(/"/g, "'");

    const logLine = `${timestamp},${blockNumber},${type},${price},${tick},"${safeDetails}"\n`;

    try {
        // 使用同步写入，确保在程序崩溃前日志已落盘
        fs.appendFileSync(LOG_FILE, logLine);
    } catch (error) {
        console.error("[Logger] Failed to write to log file:", error);
    }
}
