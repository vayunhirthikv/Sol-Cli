import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

export const CONFIG = {
  RPC_URL: process.env.RPC_URL || '',
  ALCHEMY_WS_URL: process.env.ALCHEMY_WS_URL || '',
  WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || '',
  PAPER_TRADE: process.env.PAPER_TRADE === 'true',
  BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY || '',
  DEXSCREENER_API_KEY: process.env.DEXSCREENER_API_KEY || '',
  SOLSCAN_API_KEY: process.env.SOLSCAN_API_KEY || '',
  JUPITER_API_KEY: process.env.JUPITER_API_KEY || '',
  GOPLUS_API_KEY: process.env.GOPLUS_API_KEY || '',
  
  // Hard Filters (matching webbot defaults)
  FILTERS: {
    MIN_LIQUIDITY_USD: 2000,
    MIN_VOLUME_USD: 600,
    MAX_PAIR_AGE_MINUTES: 10,
    MIN_TXN_COUNT: 20,
    MIN_UNIQUE_WALLETS: 10,
    MAX_TOP_HOLDER_PCT: 60,
  },
  
  // Strategy Rules
  ENTRY_SIZE_USD: 1,
  MAX_ACTIVE_POSITIONS: 5,
  GLOBAL_SL_USD: 1,
  GLOBAL_TP_USD:0.2,
  DEAD_POOL_LIQUIDITY_USD: 1000,
  LIQUIDITY_DROP_PCT_THRESHOLD: 50,
  SLIPPAGE_BPS: 500, // 5%
  MAX_POSITION_TIME_MS: 900000, // 3 minutes — max time a position can be held before auto-exit
  EXIT_SLIPPAGE_BPS: 10000, // 100% exit slippage to guarantee execution
  MIN_SOL_BALANCE: 0.01, // Minimum SOL balance for gas/buys
  PRIORITY_FEE_MODE: process.env.PRIORITY_FEE_MODE || 'auto', // 'auto' or a number (lamports)
};

if (!CONFIG.RPC_URL || !CONFIG.ALCHEMY_WS_URL || !CONFIG.WALLET_PRIVATE_KEY) {
  console.error("Missing required environment variables (RPC_URL, ALCHEMY_WS_URL, WALLET_PRIVATE_KEY) in .env");
  process.exit(1);
}
