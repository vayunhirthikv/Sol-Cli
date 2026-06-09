import axios from 'axios';
import { CONFIG } from './config';
import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from './logger';

const connection = new Connection(CONFIG.RPC_URL, 'confirmed');

export interface TokenData {
  address: string;
  name: string;
  symbol: string;
  liquidityUsd: number;
  volumeUsd24h: number;
  pairAgeMinutes: number;
  txn24h: number;
  uniqueWallets: number;
  topHolderPct: number | null;
  priceUsd: number;
}

const seenTokens = new Set<string>();
const pendingTokens = new Map<string, { name: string; symbol: string; detectedAt: number }>();

function queuePendingToken(address: string, info: { name: string; symbol: string; detectedAt: number }) {
  pendingTokens.set(address, info);
  
  // Enforce ceiling of 50 tokens to prevent rate-limit flooding on backoff lifts
  if (pendingTokens.size > 50) {
    const oldestKey = pendingTokens.keys().next().value;
    if (oldestKey !== undefined) {
      pendingTokens.delete(oldestKey);
      seenTokens.add(oldestKey); // Prevent rescanning
    }
  }
}

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Birdeye: getUniqueWallets via /defi/v2/tokens/trade-data/single
// This is EXACTLY what the webbot uses (birdeye.js line 42-46)
// ─────────────────────────────────────────────────────────────────────────────
async function getUniqueWallets(address: string): Promise<number> {
  if (!CONFIG.BIRDEYE_API_KEY) return 0;
  try {
    const res = await axios.get('https://public-api.birdeye.so/defi/v2/tokens/trade-data/single', {
      params: { address },
      headers: {
        'X-API-KEY': CONFIG.BIRDEYE_API_KEY,
        'Accept': 'application/json',
        'x-chain': 'solana',
      },
      timeout: 10000,
    });
    const data = res.data?.data;
    if (!data) return 0;
    return data.uniqueWallet24h || data.unique_wallet_24h || 0;
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Native On-Chain: getTopHolderPct via connection.getTokenLargestAccounts
// Consumes zero third-party API keys and works directly from RPC node
// ─────────────────────────────────────────────────────────────────────────────
async function getTopHolderPct(address: string): Promise<number | null> {
  try {
    const mintPubkey = new PublicKey(address);
    
    // 1. Fetch the 10 largest token accounts directly from RPC
    const response = await connection.getTokenLargestAccounts(mintPubkey, 'confirmed');
    const largestAccounts = response.value || [];
    if (largestAccounts.length === 0) return null;

    // 2. Fetch the total supply of the mint to calculate percentage
    const supplyInfo = await connection.getTokenSupply(mintPubkey, 'confirmed');
    const totalAmount = Number(supplyInfo.value.amount);
    if (totalAmount <= 0) return null;

    // 3. Find the first token account that is owned by a user wallet (not program PDA / DEX pool)
    for (const largest of largestAccounts) {
      try {
        const tokenAccountPubkey = new PublicKey(largest.address);
        const accountInfo = await connection.getParsedAccountInfo(tokenAccountPubkey);
        const data = accountInfo.value?.data;
        if (data && typeof data === 'object' && 'parsed' in data) {
          const ownerAddress = data.parsed?.info?.owner;
          if (ownerAddress) {
            const ownerPubkey = new PublicKey(ownerAddress);
            const ownerAccountInfo = await connection.getAccountInfo(ownerPubkey);
            
            // Check if owner is a system account (user wallet)
            const isUserWallet = !ownerAccountInfo || ownerAccountInfo.owner.toBase58() === '11111111111111111111111111111111';
            if (isUserWallet) {
              const largestAmount = Number(largest.amount);
              return (largestAmount / totalAmount) * 100;
            }
          }
        }
      } catch (err) {
        // Skip parsing errors and check next account
      }
    }
  } catch (err: any) {
    // Soft-fail on RPC errors
    return null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// DexScreener: getPairByAddress (exactly like dexscreener.js getPairByAddress)
// ─────────────────────────────────────────────────────────────────────────────
async function getDexPair(address: string): Promise<any | null> {
  try {
    const dexHeaders = CONFIG.DEXSCREENER_API_KEY ? { 'X-API-KEY': CONFIG.DEXSCREENER_API_KEY } : {};
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      timeout: 8000, headers: dexHeaders
    });
    const pairs = res.data?.pairs || [];
    const solPairs = pairs
      .filter((p: any) => p.chainId === 'solana')
      .sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const solPair = solPairs[0];
    if (!solPair) return null;
    return {
      address: solPair.baseToken?.address || address,
      name: solPair.baseToken?.name || 'Unknown',
      symbol: solPair.baseToken?.symbol || '???',
      liquidity: solPair.liquidity || { usd: 0 },
      volume: solPair.volume || { h24: 0 },
      txns: solPair.txns || { h24: { buys: 0, sells: 0 } },
      pairCreatedAt: solPair.pairCreatedAt || Date.now(),
      priceUsd: solPair.priceUsd || '0',
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Birdeye: getTokenOverview fallback (exactly like birdeye.js line 24-39)
// ─────────────────────────────────────────────────────────────────────────────
async function getBirdeyeOverview(address: string): Promise<any | null> {
  if (!CONFIG.BIRDEYE_API_KEY) return null;
  try {
    const res = await axios.get('https://public-api.birdeye.so/defi/token_overview', {
      params: { address },
      headers: {
        'X-API-KEY': CONFIG.BIRDEYE_API_KEY,
        'Accept': 'application/json',
        'x-chain': 'solana',
      },
      timeout: 10000,
    });
    return res.data?.data || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Check Mint and Freeze Authorities
// ─────────────────────────────────────────────────────────────────────────────
async function checkMintAndFreezeAuthorities(address: string): Promise<{ mintAuthority: string | null; freezeAuthority: string | null }> {
  try {
    const pubkey = new PublicKey(address);
    const accountInfo = await connection.getParsedAccountInfo(pubkey);
    const data = accountInfo.value?.data;
    if (data && typeof data === 'object' && 'parsed' in data) {
      const parsedInfo = data.parsed?.info;
      return {
        mintAuthority: parsedInfo?.mintAuthority || null,
        freezeAuthority: parsedInfo?.freezeAuthority || null,
      };
    }
  } catch (err: any) {
    // Soft-fail on RPC errors
  }
  return { mintAuthority: null, freezeAuthority: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// GoPlus: check security, honeypot and sell tax
// ─────────────────────────────────────────────────────────────────────────────
let lastGoPlusCallTime = 0;
let goPlusBlockedUntil = 0;

export function isGoPlusBackedOff(): boolean {
  return Date.now() < goPlusBlockedUntil;
}

async function goPlusRateLimit() {
  const now = Date.now();
  const wait = 1500 - (now - lastGoPlusCallTime);
  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait));
  }
  lastGoPlusCallTime = Date.now();
}

async function getGoPlusSecurity(address: string): Promise<{
  success: boolean;
  rejected?: boolean;
  rejectReason?: string;
  honeypot?: boolean;
  sellTax?: number;
} | null> {
  if (isGoPlusBackedOff()) {
    return { success: false };
  }

  await goPlusRateLimit();
  try {
    const params: Record<string, string> = { contract_addresses: address };
    if (CONFIG.GOPLUS_API_KEY) {
      params.api_key = CONFIG.GOPLUS_API_KEY;
    }
    const res = await axios.get('https://api.gopluslabs.io/api/v1/solana/token_security', {
      params,
      timeout: 10000,
      headers: { 'Accept': 'application/json' },
    });
    
    const code = res.data?.code;
    const message = res.data?.message;
    const parsedCode = code !== undefined && code !== null ? Number(code) : null;
    
    if (parsedCode === 7012) {
      return {
        success: true,
        rejected: true,
        rejectReason: `Not fungible SPL token address (${message})`,
      };
    }

    if (parsedCode === 4029) {
      logger.warn('SCANNER', `GoPlus rate limit hit (code 4029) for ${address}. Backing off for 30 seconds...`);
      goPlusBlockedUntil = Date.now() + 30000;
      return { success: false };
    }
    
    if (parsedCode !== 1) {
      logger.warn('SCANNER', `GoPlus returned non-success code ${code} for ${address}: ${message}`);
      return { success: false };
    }

    const data = res.data?.result?.[address.toLowerCase()] || 
                 res.data?.result?.[address] ||
                 Object.values(res.data?.result || {})[0];
    if (!data) {
      logger.warn('SCANNER', `GoPlus response is missing result data for ${address}`);
      return { success: false };
    }
    return {
      success: true,
      honeypot: data.is_honeypot === '1' || data.cannot_sell === '1',
      sellTax: parseFloat(data.sell_tax || '0'),
    };
  } catch (err: any) {
    if (err.response?.status === 429) {
      logger.warn('SCANNER', `GoPlus HTTP 429 received for ${address}. Backing off for 30 seconds...`);
      goPlusBlockedUntil = Date.now() + 30000;
    } else {
      logger.warn('SCANNER', `GoPlus request failed for ${address}: ${err.message}`);
    }
    return { success: false };
  }
}

/**
 * Polls for new tokens and evaluates them against Hard Filters
 * @param onTokenFound Callback triggered when a token passes all filters
 */
export async function startScanner(onTokenFound: (token: TokenData) => void) {
  logger.info('SCANNER', 'Started. Polling Birdeye...');

  async function scanLoop() {
    try {
      // ========================================
      // STEP 1: PULL addresses from all sources
      // ========================================
      const beHeaders = CONFIG.BIRDEYE_API_KEY ? { 'X-API-KEY': CONFIG.BIRDEYE_API_KEY, 'accept': 'application/json', 'x-chain': 'solana' } : {};
      const dexHeaders = CONFIG.DEXSCREENER_API_KEY ? { 'X-API-KEY': CONFIG.DEXSCREENER_API_KEY } : {};

      const rawPairs: any[] = [];

      const [profilesRes, boostsRes, beRes] = await Promise.allSettled([
        axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 5000, headers: dexHeaders }),
        axios.get('https://api.dexscreener.com/token-boosts/latest/v1', { timeout: 5000, headers: dexHeaders }),
        axios.get('https://public-api.birdeye.so/defi/v2/tokens/new_listing?limit=20', { timeout: 5000, headers: beHeaders }),
      ]);

      // DexScreener Profiles
      if (profilesRes.status === 'fulfilled' && Array.isArray(profilesRes.value.data)) {
        for (const p of profilesRes.value.data) {
          if (p.chainId === 'solana' && p.tokenAddress && !seenTokens.has(p.tokenAddress)) {
            rawPairs.push({
              address: p.tokenAddress,
              name: p.description || 'Unknown',
              symbol: p.symbol || '???',
              pairCreatedAt: Date.now(),
            });
          }
        }
      }

      // DexScreener Boosts
      if (boostsRes.status === 'fulfilled' && Array.isArray(boostsRes.value.data)) {
        for (const p of boostsRes.value.data) {
          if (p.chainId === 'solana' && p.tokenAddress && !seenTokens.has(p.tokenAddress) && !rawPairs.find(r => r.address === p.tokenAddress)) {
            rawPairs.push({
              address: p.tokenAddress,
              name: p.description || 'Unknown',
              symbol: p.symbol || '???',
              pairCreatedAt: Date.now(),
            });
          }
        }
      }

      // Birdeye New Listings
      if (beRes.status === 'fulfilled' && beRes.value.data?.data?.items) {
        for (const item of beRes.value.data.data.items) {
          if (item.address && !seenTokens.has(item.address) && !rawPairs.find(r => r.address === item.address)) {
            rawPairs.push({
              address: item.address,
              name: item.name || 'Unknown',
              symbol: item.symbol || '???',
              pairCreatedAt: item.liquidityAddedAt ? new Date(item.liquidityAddedAt + 'Z').getTime() : Date.now(),
              liquidity: { usd: item.liquidity || 0 },
            });
          }
        }
      }

      // Add pending tokens back for recheck
      for (const [addr, info] of pendingTokens) {
        if (!rawPairs.find(r => r.address === addr)) {
          rawPairs.push({ address: addr, name: info.name, symbol: info.symbol, pairCreatedAt: info.detectedAt });
        }
      }

      // ========================================
      // STEP 2: PROCESS each token (exactly like processToken in scanner.js)
      // ========================================
      let loggedBackoffThisLoop = false;
      for (const rawPair of rawPairs) {
        if (seenTokens.has(rawPair.address)) continue;

        const address = rawPair.address;

        if (isGoPlusBackedOff()) {
          if (!loggedBackoffThisLoop) {
            const timeLeft = Math.ceil((goPlusBlockedUntil - Date.now()) / 1000);
            logger.warn('SCANNER', `GoPlus backoff active (${timeLeft}s remaining). Skipping security check and queueing pending tokens...`);
            loggedBackoffThisLoop = true;
          }
          queuePendingToken(address, {
            name: rawPair.name || 'Unknown',
            symbol: rawPair.symbol || '???',
            detectedAt: rawPair.pairCreatedAt || Date.now()
          });
          continue;
        }

        await delay(500); // Rate limit protection (scanner.js line 107)

        // If no liquidity or no pairAddress, fetch real market data from DexScreener
        let realPair = rawPair;
        if (!rawPair.liquidity || rawPair.liquidity.usd === 0) {
          const fetched = await getDexPair(address);
          if (fetched) {
            realPair = {
              ...fetched,
              name: rawPair.name !== 'Unknown' ? rawPair.name : fetched.name,
              symbol: rawPair.symbol !== '???' ? rawPair.symbol : fetched.symbol,
            };
          } else {
            // Fallback to Birdeye for volume/liquidity if DexScreener blocks us
            const overview = await getBirdeyeOverview(address);
            if (overview) {
              realPair = {
                ...rawPair,
                liquidity: { usd: overview.liquidity || 0 },
                volume: { h24: overview.v24hUSD || 0 },
                txns: { h24: { buys: overview.trade24h || 0, sells: 0 } },
                priceUsd: String(overview.price || 0),
              };
            }
          }
        }

        // Extract metrics
        const liquidityUsd = realPair.liquidity?.usd || 0;
        const volumeUsd24h = realPair.volume?.h24 || 0;
        const txn24h = (realPair.txns?.h24?.buys || 0) + (realPair.txns?.h24?.sells || 0);
        const priceUsd = parseFloat(realPair.priceUsd || '0');
        const pairCreatedAt = realPair.pairCreatedAt || Date.now();
        const pairAgeMinutes = (Date.now() - pairCreatedAt) / 60000;
        const symbol = realPair.symbol || '???';
        const name = realPair.name || 'Unknown';

        // ========================================
        // STEP 3: HARD FILTERS (exact order from hardFilters.js)
        // ========================================

        // Check 0: Pair Age (check FIRST so old pending tokens die immediately)
        if (pairAgeMinutes > CONFIG.FILTERS.MAX_PAIR_AGE_MINUTES) {
          logger.info('SCANNER', `[AGED OUT] ${symbol} | ${Math.round(pairAgeMinutes)} mins old`);
          seenTokens.add(address);
          pendingTokens.delete(address);
          continue;
        }

        // Rug-Pull Check: Mint & Freeze Authorities
        const { mintAuthority, freezeAuthority } = await checkMintAndFreezeAuthorities(address);
        if (mintAuthority !== null) {
          logger.error('SCANNER', `[REJECTED] ${symbol} | Rug Risk: Mint Authority is enabled (${mintAuthority})`);
          seenTokens.add(address);
          pendingTokens.delete(address);
          continue;
        }
        if (freezeAuthority !== null) {
          logger.error('SCANNER', `[REJECTED] ${symbol} | Honeypot Risk: Freeze Authority is enabled (${freezeAuthority})`);
          seenTokens.add(address);
          pendingTokens.delete(address);
          continue;
        }

        // GoPlus Honeypot & Sell Tax checks
        const goplus = await getGoPlusSecurity(address);
        if (!goplus || !goplus.success) {
          logger.warn('SCANNER', `[PENDING] ${symbol} | GoPlus check failed (API error), queueing for retry`);
          queuePendingToken(address, { name, symbol, detectedAt: pairCreatedAt });
          continue;
        }
        if (goplus.rejected) {
          logger.error('SCANNER', `[REJECTED] ${symbol} | GoPlus Validation: ${goplus.rejectReason}`);
          seenTokens.add(address);
          pendingTokens.delete(address);
          continue;
        }
        if (goplus.honeypot) {
          logger.error('SCANNER', `[REJECTED] ${symbol} | Honeypot Risk: GoPlus flagged as honeypot / cannot sell`);
          seenTokens.add(address);
          pendingTokens.delete(address);
          continue;
        }
        if (goplus.sellTax !== undefined && goplus.sellTax > 15) {
          logger.error('SCANNER', `[REJECTED] ${symbol} | Honeypot Risk: Sell tax is too high (${goplus.sellTax.toFixed(1)}% > 15%)`);
          seenTokens.add(address);
          pendingTokens.delete(address);
          continue;
        }

        // Check 4: Liquidity
        if (liquidityUsd < CONFIG.FILTERS.MIN_LIQUIDITY_USD) {
          logger.warn('SCANNER', `[PENDING] ${symbol} | Liq $${Math.round(liquidityUsd)} / $${CONFIG.FILTERS.MIN_LIQUIDITY_USD}`);
          queuePendingToken(address, { name, symbol, detectedAt: pairCreatedAt });
          continue;
        }

        // Check 5: Volume
        if (volumeUsd24h < CONFIG.FILTERS.MIN_VOLUME_USD) {
          logger.warn('SCANNER', `[PENDING] ${symbol} | Vol $${Math.round(volumeUsd24h)} / $${CONFIG.FILTERS.MIN_VOLUME_USD}`);
          queuePendingToken(address, { name, symbol, detectedAt: pairCreatedAt });
          continue;
        }

        // Unique wallets check (soft fail — treat as 0 if API fails)
        // webbot line 156: if (!walletsPass && uniqueWallets > 0) → reject
        // if uniqueWallets === 0 (API fail) → PASS
        const uniqueWallets = await getUniqueWallets(address);
        if (uniqueWallets > 0 && uniqueWallets < CONFIG.FILTERS.MIN_UNIQUE_WALLETS) {
          logger.warn('SCANNER', `[PENDING] ${symbol} | Wallets ${uniqueWallets} / ${CONFIG.FILTERS.MIN_UNIQUE_WALLETS}`);
          queuePendingToken(address, { name, symbol, detectedAt: pairCreatedAt });
          continue;
        }

        // Check 7: Transactions
        if (txn24h < CONFIG.FILTERS.MIN_TXN_COUNT) {
          logger.warn('SCANNER', `[PENDING] ${symbol} | Txns ${txn24h} / ${CONFIG.FILTERS.MIN_TXN_COUNT}`);
          queuePendingToken(address, { name, symbol, detectedAt: pairCreatedAt });
          continue;
        }

        // Check 8: Top Holder (Solscan) — soft fail
        // webbot line 204: const holderPass = topHolderPct === null || topHolderPct <= maxTopHolder;
        // null means API failed or no data → PASS (not pending, not reject)
        const topHolderPct = await getTopHolderPct(address);
        if (topHolderPct !== null && topHolderPct > CONFIG.FILTERS.MAX_TOP_HOLDER_PCT) {
          logger.error('SCANNER', `[REJECTED] ${symbol} | Top Holder ${Math.round(topHolderPct)}% > ${CONFIG.FILTERS.MAX_TOP_HOLDER_PCT}%`);
          seenTokens.add(address);
          pendingTokens.delete(address);
          continue;
        }

        // Check 9: Valid Price
        if (priceUsd <= 0) {
          logger.warn('SCANNER', `[PENDING] ${symbol} | No price yet`);
          queuePendingToken(address, { name, symbol, detectedAt: pairCreatedAt });
          continue;
        }

        // ✅ ALL FILTERS PASSED
        seenTokens.add(address);
        pendingTokens.delete(address);

        const token: TokenData = {
          address,
          name,
          symbol,
          liquidityUsd,
          volumeUsd24h,
          pairAgeMinutes,
          txn24h,
          uniqueWallets,
          topHolderPct,
          priceUsd,
        };

        logger.success('SCANNER', `[PASS] ${symbol} | Liq $${Math.round(liquidityUsd)} | Vol $${Math.round(volumeUsd24h)} | Wallets ${uniqueWallets} | TopHolder ${topHolderPct !== null ? Math.round(topHolderPct) + '%' : 'unknown'}`);
        onTokenFound(token);
      }
    } catch (err: any) {
      logger.error('SCANNER', 'Error: ' + err.message);
    }

    // Wait 10 seconds before the next complete scan
    setTimeout(scanLoop, 10000);
  }

  scanLoop();
}
