# SolSniper CLI - Headless Execution Engine

SolSniper CLI is a high-frequency, headless Solana token sniper bot written in TypeScript. It utilizes a dual-head architecture to isolate token scanning (data ingestion) from execution (transaction signing and broadcasting) to ensure maximum speed, low latency, and protection against API rate limits.

---

## 1. Core Technology Stack

*   **Runtime Environment**: Node.js (v18+)
*   **Language**: TypeScript (v5+) compiles to ES2022 CommonJS modules.
*   **Solana Interaction**: `@solana/web3.js` (v1.98+) for RPC queries, transaction compiling, signing, and broadcasting.
*   **Token Standard**: `@solana/spl-token` (v0.4+) for Associated Token Account (ATA) derivation, token burn, and account closing instructions.
*   **HTTP Clients**: `axios` (v1.17+) for interacting with REST APIs (Jupiter, DexScreener, Birdeye, GoPlus).
*   **Configuration**: `dotenv` (v17.4+) for secure environment variable parsing.

---

## 2. System Architecture

The bot is divided into distinct, decoupled subsystems:

```
                  +-----------------------------------+
                  |           Ingestion               |
                  |  (DexScreener, Birdeye Listing)   |
                  +-----------------+-----------------+
                                    |
                                    v
                  +-----------------------------------+
                  |           Hard Filters            |
                  |  (Age, Authorities, GoPlus API)   |
                  +-----------------+-----------------+
                                    |
                                    v
+-------------------+     +---------+---------+     +-------------------+
|  Trade Manager    |<----+  Token Approved   |---->|  Executor Engine  |
|  (State Tracking) |     |  (onTokenFound)   |     |  (Jupiter Quote,  |
+---------+---------+     +-------------------+     |  v0 Transact,     |
          |                                         |  Rent Recovery)   |
          v                                         +---------+---------+
+-------------------+                                         |
|  Status Logger    |<----------------------------------------+
|  (Pinned Console) |
+-------------------+
```

1.  **Ingestion Layer (`scanner.ts`)**: Periodically queries DexScreener Token Profiles, DexScreener Boosts, and Birdeye New Listings.
2.  **Filter Layer (`scanner.ts`)**: Evaluates incoming tokens against set on-chain parameters (Mint Authority, Freeze Authority) and third-party APIs (GoPlus Token Security).
3.  **State Management (`tradeManager.ts`)**: Tracks open positions, prices, current liquidity, realized/unrealized PnL, and fees. Persists status to disk.
4.  **Action Layer (`executor.ts`)**: Signs and sends transactions via RPC. Integrates with Jupiter Quote and Swap-Instructions API (v6) to compile versioned transactions (v0), attaching prioritized fee instructions and rent recovery operations.
5.  **Telemetry Layer (`logger.ts`)**: Prints formatted logs and updates a pinned status bar at the absolute bottom of the terminal using ANSI escape codes.

---

## 3. Detailed File Walkthrough

### 3.1. src/config.ts

#### Purpose
Handles loading configuration from environment variables and defines system strategy constants.

#### Critical Constants
*   `RPC_URL`: The RPC endpoint for write operations (e.g. RPCFast).
*   `ALCHEMY_WS_URL`: Alchemy WebSocket URL for sub-millisecond wallet account updates.
*   `WALLET_PRIVATE_KEY`: Private key of Phantom/Solana wallet in base58 format.
*   `PAPER_TRADE`: Boolean flag. If true, swaps are simulated, and SOL balances are mocked.
*   `FILTERS`: Strict token parameters:
    *   `MIN_LIQUIDITY_USD` (Default: $2000)
    *   `MIN_VOLUME_USD` (Default: $600)
    *   `MAX_PAIR_AGE_MINUTES` (Default: 30 minutes)
    *   `MIN_TXN_COUNT` (Default: 20 txns)
    *   `MIN_UNIQUE_WALLETS` (Default: 10 wallets)
    *   `MAX_TOP_HOLDER_PCT` (Default: 60%)
*   `ENTRY_SIZE_USD`: Flat entry size per sniped token ($0.20).
*   `GLOBAL_SL_USD` / `GLOBAL_TP_USD`: Rolling session stop loss and take profit limits.
*   `DEAD_POOL_LIQUIDITY_USD`: Threshold below which a token is declared dead ($1000).
*   `LIQUIDITY_DROP_PCT_THRESHOLD`: Percent drop in liquidity from entry to trigger emergency exit (50%).
*   `SLIPPAGE_BPS` / `EXIT_SLIPPAGE_BPS`: Default slippage for entries (5%) and exits (15%).

---

### 3.2. src/logger.ts

#### Purpose
Manages terminal outputs. Implements a scroll-safe logging system and draws a persistent status dashboard at the bottom of the stdout.

#### Functions
*   `reprintPinnedBlock()`: Clears the previous location of the pinned block by writing ANSI escape codes (`\x1b[nA` to move cursor up, `\r\x1b[K` to carriage return and clear line) and redraws the updated status string.
*   `updatePinnedDashboard(trades, realizedUsd, totalFeesUsd, walletBalanceSol)`: Computes overall unrealized PnL, session net PnL, and real PnL (net minus fees). Composes the dashboard string and prints it.
*   `log(message)`: Temporarily moves the cursor above the pinned block, writes standard logs with local timestamps `[HH:MM:SS]`, and restores the pinned block at the bottom.
*   `logger`: Object wrapper containing helpers: `info`, `success`, `warn`, `error`, `alert`, and `paper`.

---

### 3.3. src/executor.ts

#### Purpose
Interacts with the Solana blockchain, compiles Transactions, handles token balances, priority fees, and rent reclamation.

#### Detailed Logic & Flow
1.  **SOL Price Updates (`fetchSolPriceBg`)**: Polls the price of Wrapped SOL (wSOL) from Jupiter's V2 Price API every 60 seconds to accurately compute gas fees and entry swap lamport amounts.
2.  **Buy Execution (`executeBuy`)**:
    *   Calculates necessary lamports for the swap: `(amountUsd / cachedSolPrice) * 1e9`.
    *   Calls `executeSwapInstructions(wSOL, tokenAddress, lamports, false)`.
3.  **Sell Execution (`executeSell`)**:
    *   Calls `executeSwapInstructions(tokenAddress, wSOL, amount, true)`.
    *   Falls back to `executeBurnAndClose` if Jupiter responds with a routing error (`COULD_NOT_FIND_ANY_ROUTE`), indicating zero active DEX pools.
4.  **Core Swap Builder (`executeSwapInstructions`)**:
    *   Fetches swap routing quote from `https://quote-api.jup.ag/v6/quote`.
    *   Fetches uncompiled instructions from `https://quote-api.jup.ag/v6/swap-instructions`. Passes `dynamicComputeUnitLimit: true` and `prioritizationFeeLamports: 'auto'` to dynamically calculate fee rates based on network congestion.
    *   Deserializes raw instructions (Token Ledger, Compute Budget, Setup, Swap, and Cleanup instructions).
    *   **Rent Recovery**: If selling, it appends a `createCloseAccountInstruction` targeting the token ATA. This deletes the token account on-chain and refunds the `0.002 SOL` rent fee back to the main wallet.
    *   Compiles a `VersionedTransaction` (v0) referencing Address Lookup Tables (ALTs) to keep transaction sizes below 1232 bytes.
    *   Signs and broadcasts the transaction raw byte representation to RPCFast via `connection.sendRawTransaction`.
5.  **Token Balance Polling (`getWalletTokenBalance`)**:
    *   Subscribes to account updates via wss WebSocket connection (`connection.onAccountChange`) targeting the derived Associated Token Account.
    *   Resolves as soon as the first on-chain write event occurs.
    *   Implements a 5-second HTTP fallback query (`connection.getTokenAccountBalance`) to prevent locks in case of packet loss.
6.  **Rug Recovery (`executeBurnAndClose`)**:
    *   If a token has zero sell routes, this executes a transaction containing a `createBurnInstruction` (to destroy remaining tokens) and a `createCloseAccountInstruction` (to close the ATA and reclaim the `0.002 SOL` rent).

---

### 3.4. src/scanner.ts

#### Purpose
Discovers newly launched tokens, filters them for common rug indicators, and queues candidates for security audits.

#### Key Structures
*   `seenTokens`: A `Set<string>` containing all processed token mints.
*   `pendingTokens`: A `Map` tracking tokens that failed transient checks (e.g. low liquidity or GoPlus rate-limit timeouts) to re-evaluate them.
*   `queuePendingToken(address, info)`: Implements a strict pending queue ceiling of 50 tokens. If the queue grows larger, it removes the oldest token and inserts it into `seenTokens` to prevent the bot from getting trapped in retry lag or rate-limit loops.

#### Scanning Process
1.  **Ingestion**: Fetches metadata from DexScreener token profiles, boosted tokens, and Birdeye listings.
2.  **Age Check**: Rejects tokens older than `MAX_PAIR_AGE_MINUTES` immediately.
3.  **Authority Check**: Uses `connection.getParsedAccountInfo` to verify the token mint. If `mintAuthority` or `freezeAuthority` is not null, the token is rejected.
4.  **GoPlus Security Check (`getGoPlusSecurity`)**:
    *   Calls GoPlus API Solana Token Security endpoint.
    *   Evaluates the returned status `code`. If `parsedCode` is `7012`, the token is rejected as a non-fungible token. If it is `4029` (rate limit), it sets an internal backoff time window (`goPlusBlockedUntil = Date.now() + 30000`).
    *   If GoPlus is backed off, the scanner skips the 500ms delay and queues the token silently to protect the API from rate limit locks.
    *   Rejects tokens flagged as honeypot or having a sell tax greater than 15%.
5.  **Market Metric Checks**: Rejects tokens below `MIN_LIQUIDITY_USD`, `MIN_VOLUME_USD`, `MIN_UNIQUE_WALLETS`, and `MIN_TXN_COUNT`.
6.  **Price Check**: Confirms the token has a valid positive price before approving entry.

---

### 3.5. src/tradeManager.ts

#### Purpose
Monitors open positions, checks global limits, handles state persistence, and implements emergency exits.

#### Poller Logic
Runs on a 1-second interval:
1.  Fetches live prices from Jupiter's V2 Price API for all open tokens.
2.  DexScreener Poll: Every 3 seconds, polls DexScreener to get current USD liquidity.
3.  **Emergency Exit Check**:
    *   Applies a 5-minute grace period after entry where liquidity checks are disabled to allow developers to set up initial pools.
    *   Exits if USD liquidity drops below `DEAD_POOL_LIQUIDITY_USD`.
    *   Exits if current liquidity drops by more than `LIQUIDITY_DROP_PCT_THRESHOLD` compared to entry.
    *   If a token does not return prices for 5 ticks, it is declared missing and sold at a loss to prevent memory leaks.
4.  **Global Limits Check (`checkGlobalLimits`)**:
    *   Calculates session net PnL: `totalUnrealizedUsd + sessionRealizedPnL`.
    *   If net PnL hits `GLOBAL_TP_USD` or `-GLOBAL_SL_USD`, it calls `massCloseAll()`.
    *   **Stat Isolation**: Resets `sessionRealizedPnL` to `0` but preserves the cumulative variables (`totalRealizedPnL` and `totalFeesUsd`) on disk, keeping lifetime stats intact.

---

### 3.6. src/index.ts

#### Purpose
Bootstraps the bot, performs sanity checks on startup, and captures system interrupts for safe exits.

#### Process Flow
1.  Loads env variables.
2.  Verifies the wallet contains at least `0.01 SOL` using `checkWalletSOLBalance`.
3.  Loads initial SOL price and spawns the background price update thread.
4.  Calls `startScanner` and binds it to `onTokenEntry`.
5.  **SIGINT (Ctrl+C) Handler**:
    *   Freezes the scanner instantly (`isShuttingDown = true`).
    *   Checks if there are active trades. If empty, exits immediately.
    *   If positions are open, starts a parallel panic-close transaction block for all open positions.
    *   Sets a hard timeout of 10 seconds. If transactions do not confirm within this window, the process forces an exit (`process.exit(1)`) to avoid lingering background threads.

---

## 4. Setup and Deployment

### 4.1. Environmental Variables
Create a `.env` file in the root directory:

```env
RPC_URL=https://solana-mainnet.g.alchemy.com/v2/your-key-here
ALCHEMY_WS_URL=wss://solana-mainnet.g.alchemy.com/v2/your-key-here
WALLET_PRIVATE_KEY=your-base58-private-key-string
PAPER_TRADE=true
BIRDEYE_API_KEY=your-birdeye-api-key
DEXSCREENER_API_KEY=
SOLSCAN_API_KEY=
JUPITER_API_KEY=
GOPLUS_API_KEY=
PRIORITY_FEE_MODE=auto
```

### 4.2. Running the Engine
To start the bot in development mode:
```bash
npx ts-node src/index.ts
```

To build and run in production:
```bash
npx tsc
node dist/index.js
```
