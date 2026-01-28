import * as dotenv from "dotenv";

import { ethers } from "ethers";

import { Token, Percent } from "@uniswap/sdk-core";
import { FeeAmount } from "@uniswap/v3-sdk";

dotenv.config();

const NETWORK = process.env.NETWORK || "SEPOLIA";

// --- Constants ---
export const MAX_RETRIES = 3;
export const TX_TIMEOUT_MS = 60 * 1000;

export const SLIPPAGE_TOLERANCE = new Percent(50, 10_000); // 0.5%

export const MAX_UINT128 = (1n << 128n) - 1n;

export const POOL_FEE = FeeAmount.LOW;

 export const DELTA_NEUTRAL_THRESHOLD = ethers.parseEther("0.02"); // 0.02 ETH to avoid gas waste from uncessary hedgeing

// --- RSI Thresholds ---
// If RSI > 70, market is Overbought (Don't Buy ETH)
// If RSI < 30, market is Oversold (Don't Sell ETH)
export const RSI_OVERBOUGHT = 75;
export const RSI_OVERSOLD = 25;

// -- ATR --

// a Risk Management parameter. It determines how "conservative" or "aggressive" your bot is.
// ATR (Average True Range): This tells you the average volatility over the past few hours.
// The Problem: The market doesn't always follow the "average." A sudden crash or pump can be 2x or 3x the average volatility.
export const ATR_SAFETY_FACTOR = 2;

// Buffer to prevent "whipsaw" rebalancing (Realizing IL too fast).
// This is now a percentage of the position's width.
// 0.2 means the buffer is 20% of the position's total width.
export const REBALANCE_BUFFER_FACTOR = 0.5;

// Volatility Circuit Breaker: Stop-loss mechanism
// If price deviates from the position's center by more than (WIDTH * FACTOR), exit all to USDC.
// A factor of 3.0 means if your range is +/-1%, this triggers at +/-3% deviation from center.
export const CIRCUIT_BREAKER_DEVIATION_FACTOR = 3.0;

 // [Optimized for Arbitrum] Lowered to ~1 USDC.
 // Since Gas is cheap, we can afford to rebalance even small dust to keep the ratio perfect.
export const REBALANCE_THRESHOLD_USDC = 1_000_000n; 
// ~0.0005 ETH
export const REBALANCE_THRESHOLD_WETH = 500_000_000_000_000n; 


// --- ABIs ---
export const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
];

export const POOL_ABI = [
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() view returns (uint128)",
    "function tickSpacing() view returns (int24)",
    "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)"
];

export const NPM_ABI = [
    "event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)",
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
    "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
    "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
    "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
    "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint256 amount0, uint256 amount1)",
    "function burn(uint256 tokenId) payable",
    "function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)",
    "function balanceOf(address owner) view returns (uint256)",
    "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)"
];

export const SWAP_ROUTER_ABI = [
    "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)",
    "function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountIn)",
];

export const QUOTER_ABI = [
    "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
    "function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"
];

// --- Network Configuration ---
const safeLower = (addr: string) => addr.toLowerCase();

let CHAIN_ID: number;
let WETH_TOKEN_CONF: Token;
let USDC_TOKEN_CONF: Token;
let NPM_ADDR_CONF: string;
let V3_FACTORY_ADDR_CONF: string;
let SWAP_ROUTER_ADDR_CONF: string;
let QUOTER_ADDR_CONF: string;

if (NETWORK === "MAINNET") {
    // https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info
    CHAIN_ID = 42161;

    // https://arbiscan.io/token/0x82af49447d8a07e3bd95bd0d56f35241523fbab1
    WETH_TOKEN_CONF = new Token(
        CHAIN_ID,
        safeLower("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"),
        18,
        "WETH",
        "Wrapped Ether"
    );

    // https://arbiscan.io/token/0xaf88d065e77c8cc2239327c5edb3a432268e5831
    USDC_TOKEN_CONF = new Token(
        CHAIN_ID,
        safeLower("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
        6,
        "USDC",
        "USD Coin"
    );

    // https://docs.uniswap.org/contracts/v3/reference/deployments/arbitrum-deployments
    NPM_ADDR_CONF = safeLower("0xC36442b4a4522E871399CD717aBDD847Ab11FE88");
    V3_FACTORY_ADDR_CONF = safeLower(
        "0x1F98431c8aD98523631AE4a59f267346ea31F984"
    );
    SWAP_ROUTER_ADDR_CONF = safeLower(
        "0xE592427A0AEce92De3Edee1F18E0157C05861564"
    );

    QUOTER_ADDR_CONF = safeLower("0x61fFE014bA17989E743c5F6cB21bF9697530B21e");

} else {
    // Sepolia
    CHAIN_ID = 11155111;
    WETH_TOKEN_CONF = new Token(
        CHAIN_ID,
        safeLower("0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14"),
        18,
        "WETH",
        "Wrapped Ether"
    );
    USDC_TOKEN_CONF = new Token(
        CHAIN_ID,
        safeLower("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"),
        6,
        "USDC",
        "USD Coin"
    );
    V3_FACTORY_ADDR_CONF = safeLower(
        "0x0227628f3F023bb0B980b67D528571c95c6DaC1c"
    );
    NPM_ADDR_CONF = safeLower("0x1238536071E1c677A632429e3655c799b22cDA52");
    SWAP_ROUTER_ADDR_CONF = safeLower(
        "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E"
    );
    QUOTER_ADDR_CONF = safeLower("0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3");
}

export const CURRENT_CHAIN_ID = CHAIN_ID;
export const WETH_TOKEN = WETH_TOKEN_CONF;
export const USDC_TOKEN = USDC_TOKEN_CONF;
export const NONFUNGIBLE_POSITION_MANAGER_ADDR = NPM_ADDR_CONF;
export const V3_FACTORY_ADDR = V3_FACTORY_ADDR_CONF;
export const SWAP_ROUTER_ADDR = SWAP_ROUTER_ADDR_CONF;
export const QUOTER_ADDR = QUOTER_ADDR_CONF;