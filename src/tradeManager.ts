import { executeBuy, executeSell, getWalletTokenBalance, getTransactionFeeUsd, getWalletSOLBalance, cachedSolPrice } from './executor';
import { CONFIG } from './config';
import { logger, updatePinnedDashboard } from './logger';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

export interface OpenTrade {
  tokenAddress: string;
  amountRaw: number;
  entryPriceUsd: number;
  currentPriceUsd: number;
  openedAt: number;
  entryLiquidityUsd: number;
  currentLiquidityUsd: number;
}

export const activeTrades = new Map<string, OpenTrade>();
export const pendingEntries = new Set<string>();
export let totalRealizedPnL = 0;
export let totalFeesUsd = 0;
export let walletBalanceSol = 0;
export let sessionRealizedPnL = 0;

const logFilePath = path.resolve(__dirname, '../trades.log');
const activeTradesFilePath = path.resolve(__dirname, '../active_trades.json');
const sessionStatsFilePath = path.resolve(__dirname, '../session_stats.json');

function saveActiveTrades() {
  try {
    const data = Array.from(activeTrades.entries());
    fs.writeFileSync(activeTradesFilePath, JSON.stringify(data, null, 2));
  } catch (err: any) {
    logger.error('MANAGER', `Failed to save active trades: ${err.message}`);
  }
}

export function loadActiveTrades() {
  if (fs.existsSync(activeTradesFilePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(activeTradesFilePath, 'utf8'));
      activeTrades.clear();
      for (const [address, trade] of data) {
        trade.openedAt = trade.openedAt || Date.now();
        trade.entryLiquidityUsd = trade.entryLiquidityUsd || 0;
        trade.currentLiquidityUsd = trade.currentLiquidityUsd !== undefined ? trade.currentLiquidityUsd : (trade.entryLiquidityUsd || 0);
        activeTrades.set(address, trade);
      }
      logger.info('MANAGER', `Loaded ${activeTrades.size} active trades from storage.`);
    } catch (e: any) {
      logger.error('MANAGER', `Failed to load active trades from storage: ${e.message}`);
    }
  }
}

function saveSessionStats() {
  try {
    fs.writeFileSync(sessionStatsFilePath, JSON.stringify({
      totalRealizedPnL,
      totalFeesUsd,
      simulatedBalanceSol: CONFIG.PAPER_TRADE ? walletBalanceSol : 10.0,
      sessionRealizedPnL
    }, null, 2));
  } catch (err: any) {
    logger.error('MANAGER', `Failed to save session stats: ${err.message}`);
  }
}

export function loadSessionStats() {
  if (fs.existsSync(sessionStatsFilePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(sessionStatsFilePath, 'utf8'));
      totalRealizedPnL = data.totalRealizedPnL || 0;
      totalFeesUsd = data.totalFeesUsd || 0;
      sessionRealizedPnL = data.sessionRealizedPnL || 0;
      if (CONFIG.PAPER_TRADE) {
        walletBalanceSol = data.simulatedBalanceSol !== undefined ? data.simulatedBalanceSol : 10.0;
      }
      logger.info('MANAGER', `Loaded stats: Realise: $${sessionRealizedPnL.toFixed(2)}, Fee: $${totalFeesUsd.toFixed(2)}, Total PnL (incl. fee): $${(totalRealizedPnL - totalFeesUsd).toFixed(2)}, Balance: ${walletBalanceSol.toFixed(4)} SOL`);
    } catch (e: any) {
      logger.error('MANAGER', `Failed to load session stats: ${e.message}`);
    }
  } else if (CONFIG.PAPER_TRADE) {
    walletBalanceSol = 10.0;
  }
}

// Background SOL balance refresher
async function refreshWalletBalance() {
  try {
    if (CONFIG.PAPER_TRADE) {
      return;
    }
    walletBalanceSol = await getWalletSOLBalance();
  } catch (err) {
    // Ignore
  }
}

// Initialize state
loadActiveTrades();
loadSessionStats();
refreshWalletBalance();
setInterval(refreshWalletBalance, 5000);

export async function onTokenEntry(tokenAddress: string, priceUsd: number, entryLiquidityUsd: number) {
  if (activeTrades.has(tokenAddress) || pendingEntries.has(tokenAddress)) return;

  if (activeTrades.size + pendingEntries.size >= CONFIG.MAX_ACTIVE_POSITIONS) {
    logger.warn('MANAGER', `Max active positions limit reached (${CONFIG.MAX_ACTIVE_POSITIONS}). Skipping entry for ${tokenAddress}`);
    return;
  }

  // Reserve position space immediately to avoid parallel race condition
  pendingEntries.add(tokenAddress);

  try {
    logger.info('MANAGER', `Entering Trade: ${tokenAddress}`);
    
    // 1. Execute Buy via RPCFast
    const txHash = await executeBuy(tokenAddress, CONFIG.ENTRY_SIZE_USD);
    if (!txHash) {
      pendingEntries.delete(tokenAddress);
      return;
    }

    // Track fee asynchronously in the background
    getTransactionFeeUsd(txHash).then(fee => {
      totalFeesUsd += fee;
      if (CONFIG.PAPER_TRADE) {
        const spentSol = (CONFIG.ENTRY_SIZE_USD + fee) / cachedSolPrice;
        walletBalanceSol -= spentSol;
      }
      saveSessionStats();
      checkGlobalLimits();
    });

    // Derive the exact amountRaw (mocked in paper trade, read on-chain in live trade)
    let amountRaw = 0;
    if (CONFIG.PAPER_TRADE) {
      // Simulate raw amount assuming 6 decimals for simplicity
      amountRaw = Math.floor((CONFIG.ENTRY_SIZE_USD / priceUsd) * 1e6);
    } else {
      amountRaw = await getWalletTokenBalance(tokenAddress);
      if (amountRaw === 0) {
        logger.error('MANAGER', `Failed to fetch on-chain token balance for ${tokenAddress}. Skipping trade tracking.`);
        pendingEntries.delete(tokenAddress);
        return;
      }
    }

    activeTrades.set(tokenAddress, {
      tokenAddress,
      amountRaw,
      entryPriceUsd: priceUsd,
      currentPriceUsd: priceUsd,
      openedAt: Date.now(),
      entryLiquidityUsd,
      currentLiquidityUsd: entryLiquidityUsd,
    });
    saveActiveTrades();
  } catch (err: any) {
    logger.error('MANAGER', `Error entering trade for ${tokenAddress}: ${err.message}`);
  } finally {
    pendingEntries.delete(tokenAddress);
  }
}

let lastDexScreenerPoll = 0;
const missingTicks = new Map<string, number>();

// Price tracking via Jupiter API (with DexScreener fallback)
setInterval(async () => {
  if (activeTrades.size === 0) {
    updatePinnedDashboard([], totalRealizedPnL, sessionRealizedPnL, totalFeesUsd, walletBalanceSol);
    return;
  }

  const addresses = Array.from(activeTrades.keys());
  const missingAddresses: string[] = [];
  let prices: any = {};

  // 1. Fetch from Jupiter Price API V2 (Fast 1s interval)
  try {
    const headers: Record<string, string> = {};
    if (CONFIG.JUPITER_API_KEY) {
      headers['x-api-key'] = CONFIG.JUPITER_API_KEY;
    }

    const response = await axios.get(`https://api.jup.ag/price/v2?ids=${addresses.join(',')}`, { headers });
    prices = response.data?.data || {};

    for (const address of addresses) {
      const trade = activeTrades.get(address);
      if (trade) {
        if (prices[address]?.price) {
          trade.currentPriceUsd = parseFloat(prices[address].price);
          missingTicks.delete(address); // Reset missing counter
        } else {
          missingAddresses.push(address);
        }
      }
    }
  } catch (err: any) {
    // If Jupiter fails, treat all addresses as missing/fallback
    missingAddresses.push(...addresses);
  }

  // 2. Fetch all active tokens from DexScreener (throttled to 3s) to update liquidity and check rugs
  const now = Date.now();
  if (now - lastDexScreenerPoll >= 3000) {
    lastDexScreenerPoll = now;
    try {
      const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${addresses.join(',')}`);
      const pairs = response.data?.pairs || [];

      for (const address of addresses) {
        const trade = activeTrades.get(address);
        if (trade) {
          const isGracePeriod = (now - trade.openedAt) < 300000;
          const matchingPairs = pairs
            .filter((p: any) => p.chainId === 'solana' && (p.baseToken?.address === address || p.pairAddress === address))
            .sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
          const pair = matchingPairs[0];

          if (pair) {
            trade.currentLiquidityUsd = pair.liquidity?.usd || 0;
            // Only update price from DexScreener if we didn't get it from Jupiter
            if (!prices[address]?.price) {
              trade.currentPriceUsd = parseFloat(pair.priceUsd || '0');
            }
            missingTicks.delete(address); // Reset missing counter

            // --- Emergency Exits (Matching Webbot Logic) ---
            const deadPoolLiq = CONFIG.DEAD_POOL_LIQUIDITY_USD || 1000;
            const liqDropPctThreshold = CONFIG.LIQUIDITY_DROP_PCT_THRESHOLD || 50;

            if (trade.currentLiquidityUsd < deadPoolLiq && !isGracePeriod) {
              logger.alert('MANAGER', `[RUG DETECTED] Liquidity for ${address} is dead ($${trade.currentLiquidityUsd.toFixed(0)} < $${deadPoolLiq})! Closing position...`);
              trade.currentPriceUsd = 0.000001; // Force exit at loss
              closeSinglePosition(address);
            } else if (trade.entryLiquidityUsd > 0 && !isGracePeriod) {
              const liqDrop = ((trade.entryLiquidityUsd - trade.currentLiquidityUsd) / trade.entryLiquidityUsd) * 100;
              if (liqDrop > liqDropPctThreshold) {
                logger.alert('MANAGER', `[LIQUIDITY DROP] Liquidity for ${address} dropped by ${liqDrop.toFixed(1)}% (Threshold: ${liqDropPctThreshold}%)! Closing position...`);
                trade.currentPriceUsd = 0.000001;
                closeSinglePosition(address);
              }
            }
          } else {
            // Not found on DexScreener
            if (missingAddresses.includes(address)) {
              if (isGracePeriod) {
                missingTicks.delete(address);
                if (CONFIG.PAPER_TRADE) {
                  trade.currentPriceUsd *= (1 + (Math.random() * 0.02 - 0.01));
                }
              } else {
                const ticks = (missingTicks.get(address) || 0) + 1;
                missingTicks.set(address, ticks);

                if (ticks >= 5) {
                  logger.alert('MANAGER', `Paper Trade Rug/Missing detected for ${address}! Closing position...`);
                  trade.currentPriceUsd = 0.000001;
                  closeSinglePosition(address);
                } else if (CONFIG.PAPER_TRADE) {
                  trade.currentPriceUsd *= (1 + (Math.random() * 0.02 - 0.01));
                }
              }
            }
          }
        }
      }
    } catch (err) {
      // Silently ignore DexScreener errors
    }
  } else {
    // If DexScreener is throttled, simulate small random fluctuations for paper trading and check grace period
    for (const address of missingAddresses) {
      const trade = activeTrades.get(address);
      if (trade) {
        const isGracePeriod = (now - trade.openedAt) < 300000;
        if (isGracePeriod) {
          missingTicks.delete(address);
        }
        if (CONFIG.PAPER_TRADE) {
          trade.currentPriceUsd *= (1 + (Math.random() * 0.02 - 0.01));
        }
      }
    }
  }

  checkGlobalLimits();
}, 1000); // Poll every 1 second

export async function onPriceUpdate(tokenAddress: string, priceUsd: number) {
  // Now handled by the polling loop above
}

/**
 * Calculates global PnL and executes mass-close if SL/TP hit
 */
export async function checkGlobalLimits() {
  let totalUnrealizedUsd = 0;
  const tradesArray = [];

  for (const [address, trade] of activeTrades.entries()) {
    const entryValue = CONFIG.ENTRY_SIZE_USD;
    const currentValue = (trade.currentPriceUsd / trade.entryPriceUsd) * entryValue;
    totalUnrealizedUsd += (currentValue - entryValue);
    
    tradesArray.push({
      address: trade.tokenAddress,
      amountRaw: trade.amountRaw,
      entryPriceUsd: trade.entryPriceUsd,
      currentPriceUsd: trade.currentPriceUsd,
    });
  }

  // Update pinned dashboard feed (with both total and session realized PnL)
  updatePinnedDashboard(tradesArray, totalRealizedPnL, sessionRealizedPnL, totalFeesUsd, walletBalanceSol);

  // Rolling Session Net P&L: includes open unrealized P&L + active session realized P&L
  const sessionNetPnlUsd = totalUnrealizedUsd + sessionRealizedPnL;

  if (sessionNetPnlUsd >= CONFIG.GLOBAL_TP_USD) {
    logger.success('MANAGER', `[TP HIT] Global Take Profit ($${CONFIG.GLOBAL_TP_USD}) HIT! (Net PnL: $${sessionNetPnlUsd.toFixed(2)}) Mass closing...`);
    await massCloseAll();
    
    // Reset unrealize, realise, and net back to $0 on hit
    sessionRealizedPnL = 0;
    saveSessionStats();
    logger.info('MANAGER', 'Reset Unrealize, Realise, and Net P&L to $0 after Take Profit hit.');
  } else if (sessionNetPnlUsd <= -CONFIG.GLOBAL_SL_USD) {
    logger.alert('MANAGER', `[SL HIT] Global Stop Loss ($${CONFIG.GLOBAL_SL_USD}) HIT! (Net PnL: $${sessionNetPnlUsd.toFixed(2)}) Mass closing...`);
    await massCloseAll();
    
    // Reset unrealize, realise, and net back to $0 on hit
    sessionRealizedPnL = 0;
    saveSessionStats();
    logger.info('MANAGER', 'Reset Unrealize, Realise, and Net P&L to $0 after Stop Loss hit.');
  }
}

export const closingTrades = new Set<string>();

export async function closeSinglePosition(address: string) {
  if (closingTrades.has(address)) return;
  closingTrades.add(address);

  const trade = activeTrades.get(address);
  if (!trade) {
    closingTrades.delete(address);
    return;
  }

  try {
    const res = await executeSell(trade.tokenAddress, trade.amountRaw);
    if (res) {
      const entryValue = CONFIG.ENTRY_SIZE_USD;
      let exitPriceUsd = trade.currentPriceUsd;
      let tradePnl = 0;

      if (res.isBurn) {
        exitPriceUsd = 0;
        tradePnl = -entryValue;
        logger.alert('MANAGER', `[RUG FALLBACK] Closed ${address} (RUGGED/BURNED fallback) | PnL: -$${entryValue.toFixed(2)} | TX: ${res.txHash}`);
      } else {
        const currentValue = (trade.currentPriceUsd / trade.entryPriceUsd) * entryValue;
        tradePnl = currentValue - entryValue;
        logger.success('MANAGER', `Closed ${address} | PnL: $${tradePnl.toFixed(2)} | TX: ${res.txHash}`);
      }

      totalRealizedPnL += tradePnl;
      sessionRealizedPnL += tradePnl;
      saveSessionStats();

      const fee = await getTransactionFeeUsd(res.txHash);
      totalFeesUsd += fee;
      if (CONFIG.PAPER_TRADE) {
        const gainedSol = (entryValue + tradePnl - fee) / cachedSolPrice;
        walletBalanceSol += gainedSol;
      }
      saveSessionStats();
      checkGlobalLimits();

      // Log to file
      fs.appendFileSync(logFilePath, JSON.stringify({
        timestamp: new Date().toISOString(),
        token: address,
        entryPriceUsd: trade.entryPriceUsd,
        exitPriceUsd: exitPriceUsd,
        pnlUsd: tradePnl,
        txHash: res.txHash,
        isBurn: res.isBurn
      }) + '\n');

      activeTrades.delete(address);
      saveActiveTrades();
    } else {
      logger.error('MANAGER', `Failed to close position for ${address}. Keeping in active trades.`);
    }
  } catch (err: any) {
    logger.error('MANAGER', `Error closing position for ${address}: ${err.message || err}`);
  } finally {
    closingTrades.delete(address);
  }
}

export async function massCloseAll() {
  logger.warn('MANAGER', `Initiating Mass-Close for ${activeTrades.size} positions...`);
  const promises = [];
  
  for (const [address, trade] of activeTrades.entries()) {
    if (closingTrades.has(address)) continue;
    closingTrades.add(address);

    promises.push(
      (async () => {
        try {
          const res = await executeSell(trade.tokenAddress, trade.amountRaw);
          if (res) {
            const entryValue = CONFIG.ENTRY_SIZE_USD;
            let exitPriceUsd = trade.currentPriceUsd;
            let tradePnl = 0;

            if (res.isBurn) {
              exitPriceUsd = 0;
              tradePnl = -entryValue;
              logger.alert('MANAGER', `[RUG FALLBACK] Closed ${address} (RUGGED/BURNED fallback) | PnL: -$${entryValue.toFixed(2)} | TX: ${res.txHash}`);
            } else {
              const currentValue = (trade.currentPriceUsd / trade.entryPriceUsd) * entryValue;
              tradePnl = currentValue - entryValue;
              logger.success('MANAGER', `Closed ${address} | PnL: $${tradePnl.toFixed(2)} | TX: ${res.txHash}`);
            }
            
            totalRealizedPnL += tradePnl;
            sessionRealizedPnL += tradePnl;
            saveSessionStats();
            
            const fee = await getTransactionFeeUsd(res.txHash);
            totalFeesUsd += fee;
            if (CONFIG.PAPER_TRADE) {
              const gainedSol = (entryValue + tradePnl - fee) / cachedSolPrice;
              walletBalanceSol += gainedSol;
            }
            saveSessionStats();
            
            // Log to file
            fs.appendFileSync(logFilePath, JSON.stringify({
              timestamp: new Date().toISOString(),
              token: address,
              entryPriceUsd: trade.entryPriceUsd,
              exitPriceUsd: exitPriceUsd,
              pnlUsd: tradePnl,
              txHash: res.txHash,
              isBurn: res.isBurn
            }) + '\n');

            // Only delete from activeTrades if successfully sold on-chain
            activeTrades.delete(address);
            saveActiveTrades();
          } else {
            logger.error('MANAGER', `Failed to close position for ${address}. Keeping in active trades.`);
          }
        } catch (err: any) {
          logger.error('MANAGER', `Error closing position for ${address}: ${err.message || err}`);
        } finally {
          closingTrades.delete(address);
        }
      })()
    );
  }

  await Promise.allSettled(promises);
  logger.info('MANAGER', `Mass-Close Complete. Remaining open positions: ${activeTrades.size}`);
  
  // Re-render the dashboard
  const remainingTrades = Array.from(activeTrades.values()).map(t => ({
    address: t.tokenAddress,
    amountRaw: t.amountRaw,
    entryPriceUsd: t.entryPriceUsd,
    currentPriceUsd: t.currentPriceUsd,
  }));
  updatePinnedDashboard(remainingTrades, totalRealizedPnL, sessionRealizedPnL, totalFeesUsd, walletBalanceSol);
}
