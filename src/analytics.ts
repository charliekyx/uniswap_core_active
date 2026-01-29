import axios from "axios";
import { RSI, ATR, ADX, BollingerBands } from "technicalindicators";
import { withRetry } from "./utils"; // Reuse retry logic

// Binance API for public market data
const BINANCE_API_URL = "https://api.binance.us/api/v3/klines"; // Prioritize US for stability
const BINANCE_GLOBAL_URL = "https://api.binance.com/api/v3/klines";

// Coinbase API for fallback (ETH-USD)
const COINBASE_API_URL = "https://api.exchange.coinbase.com/products/ETH-USD/candles";
// Kraken API for fallback
const KRAKEN_API_URL = "https://api.kraken.com/0/public/OHLC";

interface CandleData {
    high: number[];
    low: number[];
    close: number[];
}

async function fetchFromCoinbase(interval: string): Promise<CandleData> {
    // Map interval to seconds (Coinbase 'granularity')
    const granularityMap: Record<string, number> = {
        "1m": 60,
        "5m": 300,
        "15m": 900,
        "1h": 3600,
        "6h": 21600,
        "1d": 86400,
    };
    const granularity = granularityMap[interval] || 900;

    try {
        const response = await axios.get(COINBASE_API_URL, {
            params: { granularity },
            timeout: 3000,
        });

        const sorted = response.data.reverse();
        return {
            high: sorted.map((c: number[]) => c[2]),
            low: sorted.map((c: number[]) => c[1]),
            close: sorted.map((c: number[]) => c[4]),
        };
    } catch (error) {
        throw new Error(`Coinbase failed: ${(error as Error).message}`);
    }
}

async function fetchFromKraken(interval: string): Promise<CandleData> {
    const intervalMap: Record<string, number> = {
        "1m": 1,
        "5m": 5,
        "15m": 15,
        "1h": 60,
        "4h": 240,
        "1d": 1440,
    };
    const minutes = intervalMap[interval] || 15;

    try {
        const response = await axios.get(KRAKEN_API_URL, {
            params: { pair: "ETHUSD", interval: minutes },
            timeout: 3000,
        });

        if (response.data.error && response.data.error.length > 0)
            throw new Error(response.data.error.join(", "));

        const keys = Object.keys(response.data.result).filter((k) => k !== "last");
        const data = response.data.result[keys[0]];

        return {
            high: data.map((c: any[]) => parseFloat(c[2])),
            low: data.map((c: any[]) => parseFloat(c[3])),
            close: data.map((c: any[]) => parseFloat(c[4])),
        };
    } catch (error) {
        throw new Error(`Kraken failed: ${(error as Error).message}`);
    }
}

async function fetchFromBinance(
    symbol: string,
    interval: string,
    limit: number,
): Promise<CandleData> {
    // Try US first, then Global
    const urls = [BINANCE_API_URL, BINANCE_GLOBAL_URL];

    for (const url of urls) {
        try {
            const response = await axios.get(url, {
                params: { symbol, interval, limit },
                timeout: 3000,
            });
            return {
                high: response.data.map((c: any[]) => parseFloat(c[2])),
                low: response.data.map((c: any[]) => parseFloat(c[3])),
                close: response.data.map((c: any[]) => parseFloat(c[4])),
            };
        } catch (error: any) {
            if (error.response?.status === 451) continue; // Geo-blocked, try next
        }
    }
    throw new Error("Binance failed");
}

async function fetchCandles(symbol: string, interval: string, limit: number): Promise<CandleData> {
    // Priority: Coinbase -> Kraken -> Binance
    try {
        return await fetchFromCoinbase(interval);
    } catch (e) {
        /* ignore */
    }
    try {
        return await fetchFromKraken(interval);
    } catch (e) {
        /* ignore */
    }
    try {
        return await fetchFromBinance(symbol, interval, limit);
    } catch (e) {
        /* ignore */
    }

    throw new Error(`Failed to fetch market data from all sources.`);
}

export async function getEthRsi(interval: string = "15m", period: number = 14): Promise<number> {
    try {
        // Use withRetry to increase stability
        const data = await withRetry(() => fetchCandles("ETHUSDT", interval, period + 50));

        const inputRSI = {
            values: data.close,
            period: period,
        };

        const rsiResult = RSI.calculate(inputRSI);

        if (rsiResult.length > 0) {
            return rsiResult[rsiResult.length - 1];
        }
        throw new Error("Insufficient data for RSI");
    } catch (error) {
        console.error(`[Analytics] Failed to fetch RSI: ${(error as Error).message}`);
        throw error; // Throw error to stop strategy execution and prevent wrong positioning
    }
}

/**
 * Calculate Average True Range (ATR) to measure volatility in USD.
 * Returns the average dollar movement per candle (e.g., $30).
 */
export async function getEthAtr(interval: string = "15m", period: number = 14): Promise<number> {
    try {
        // Use withRetry to increase stability
        const data = await withRetry(() => fetchCandles("ETHUSDT", interval, period + 20));

        const inputATR = {
            high: data.high,
            low: data.low,
            close: data.close,
            period: period,
        };

        const atrResult = ATR.calculate(inputATR);

        if (atrResult.length > 0) {
            return atrResult[atrResult.length - 1];
        }

        throw new Error("Insufficient data for ATR");
    } catch (error) {
        console.error(`[Analytics] Failed to fetch ATR: ${(error as Error).message}`);
        throw error;
    }
}

/**
 * Calculate Average Directional Index (ADX) to measure trend strength.
 * ADX > 25 usually indicates a strong trend.
 */
export async function getEthAdx(interval: string = "15m", period: number = 14): Promise<number> {
    try {
        // Use withRetry to increase stability
        const data = await withRetry(() => fetchCandles("ETHUSDT", interval, period + 50));

        const inputADX = {
            high: data.high,
            low: data.low,
            close: data.close,
            period: period,
        };

        const adxResult = ADX.calculate(inputADX);

        if (adxResult.length > 0) {
            return adxResult[adxResult.length - 1].adx;
        }

        throw new Error("Insufficient data for ADX");
    } catch (error) {
        console.error(`[Analytics] Failed to fetch ADX: ${(error as Error).message}`);
        throw error;
    }
}

/**
 * Calculate Bollinger Bands to find statistical extremes.
 * Standard: Period 20, StdDev 2.
 */
export async function getEthBollingerBands(
    interval: string = "1h",
    period: number = 20,
    stdDev: number = 2,
): Promise<{ upper: number; middle: number; lower: number }> {
    try {
        // Fetch enough data for calculation
        const data = await withRetry(() => fetchCandles("ETHUSDT", interval, period + 20));

        const inputBB = {
            period: period,
            values: data.close,
            stdDev: stdDev,
        };

        const bbResult = BollingerBands.calculate(inputBB);

        if (bbResult.length > 0) {
            return bbResult[bbResult.length - 1];
        }
        throw new Error("Insufficient data for Bollinger Bands");
    } catch (error) {
        console.error(`[Analytics] Failed to fetch BB: ${(error as Error).message}`);
        throw error;
    }
}
