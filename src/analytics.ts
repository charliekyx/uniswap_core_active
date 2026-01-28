import axios from 'axios';
import { RSI, ATR } from 'technicalindicators';
import { withRetry } from './utils'; // Reuse retry logic

// Binance API for public market data
const BINANCE_API_URLS = [
    'https://api.binance.com/api/v3/klines',
    'https://api.binance.us/api/v3/klines',     // US fallback
    'https://api1.binance.com/api/v3/klines',   // Alt domain 1
    'https://api2.binance.com/api/v3/klines',   // Alt domain 2
    'https://api3.binance.com/api/v3/klines'    // Alt domain 3
];

// Coinbase API for fallback (ETH-USD)
const COINBASE_API_URL = 'https://api.exchange.coinbase.com/products/ETH-USD/candles';

interface CandleData {
    high: number[];
    low: number[];
    close: number[];
}

async function fetchCandles(symbol: string, interval: string, limit: number): Promise<CandleData> {
    let lastError: any;

    for (const url of BINANCE_API_URLS) {
        try {
            const response = await axios.get(url, {
                params: {
                    symbol: symbol,
                    interval: interval,
                    limit: limit
                },
                timeout: 5000 // 5s timeout per node to fail fast
            });

            // Binance API format: [open_time, open, high, low, close, ...]
            // Index: 2=High, 3=Low, 4=Close
            const highs = response.data.map((c: any[]) => parseFloat(c[2]));
            const lows = response.data.map((c: any[]) => parseFloat(c[3]));
            const closes = response.data.map((c: any[]) => parseFloat(c[4]));

            return { high: highs, low: lows, close: closes };
        } catch (error) {
            console.warn(`[Analytics] Failed to fetch from ${url}: ${(error as Error).message}. Trying next...`);
            lastError = error;
        }
    }

    // Fallback to Coinbase
    try {
        console.warn(`[Analytics] Binance nodes failed. Trying Coinbase fallback...`);
        
        // Map interval to seconds (Coinbase 'granularity')
        // 1m=60, 5m=300, 15m=900, 1h=3600, 6h=21600, 1d=86400
        const granularityMap: Record<string, number> = {
            '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400
        };
        const granularity = granularityMap[interval] || 900;

        const response = await axios.get(COINBASE_API_URL, {
            params: { granularity },
            timeout: 5000
        });

        // Coinbase response: [ [time, low, high, open, close, volume], ... ] (Newest first)
        // We need to reverse it to be Oldest first for technical indicators
        const sorted = response.data.reverse();
        
        const highs = sorted.map((c: number[]) => c[2]); // Index 2 = High
        const lows = sorted.map((c: number[]) => c[1]);  // Index 1 = Low
        const closes = sorted.map((c: number[]) => c[4]); // Index 4 = Close

        return { high: highs, low: lows, close: closes };
    } catch (error) {
        console.warn(`[Analytics] Failed to fetch from Coinbase: ${(error as Error).message}`);
        lastError = error;
    }

    throw new Error(`Failed to fetch market data from all sources. Last error: ${(lastError as Error).message}`);
}

export async function getEthRsi(interval: string = '15m', period: number = 14): Promise<number> {
    try {
        // Use withRetry to increase stability
        const data = await withRetry(() => fetchCandles('ETHUSDT', interval, period + 50));
        
        const inputRSI = {
            values: data.close,
            period: period
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
export async function getEthAtr(interval: string = '15m', period: number = 14): Promise<number> {
    try {
        // Use withRetry to increase stability
        const data = await withRetry(() => fetchCandles('ETHUSDT', interval, period + 20));
        
        const inputATR = {
            high: data.high,
            low: data.low,
            close: data.close,
            period: period
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