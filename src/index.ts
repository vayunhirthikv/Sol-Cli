import { startScanner } from './scanner';
import { onTokenEntry, massCloseAll, activeTrades } from './tradeManager';
import { checkWalletSOLBalance, fetchSolPriceBg } from './executor';
import { logger } from './logger';

let isShuttingDown = false;

async function main() {
  console.log(`
=============================================
  SolSniper CLI - Headless Execution Engine
=============================================
  [Data] Alchemy WebSockets
  [Exec] RPCFast SWQoS
  [DEX]  Jupiter /swap-instructions
=============================================
`);

  // Verify wallet SOL balance before running
  const balanceOk = await checkWalletSOLBalance();
  if (!balanceOk) {
    logger.error('SYSTEM', 'Aborting startup due to insufficient SOL for gas/transactions.');
    process.exit(1);
  }

  // Fetch initial SOL price for exact lamport calculations on entries
  await fetchSolPriceBg();
  // Keep refreshing SOL price in the background every 60 seconds
  setInterval(fetchSolPriceBg, 60000);

  // Start Scanner
  startScanner((token) => {
    if (isShuttingDown) return;
    onTokenEntry(token.address, token.priceUsd, token.liquidityUsd);
  });
}

// ── EXPERT ADVISOR KILL SWITCH (PANIC BUTTON) ──
process.on('SIGINT', async () => {
  if (isShuttingDown) {
    logger.info('PANIC BUTTON', 'Force exiting...');
    process.exit(1);
  }

  isShuttingDown = true;

  if (activeTrades.size === 0) {
    logger.success('PANIC BUTTON', 'Safe shutdown complete. No open positions to close.');
    process.exit(0);
  }

  logger.alert('PANIC BUTTON', 'SIGINT Intercepted! Freezing scanner...');
  logger.alert('PANIC BUTTON', `Mass-closing ${activeTrades.size} open positions immediately!`);

  const forceExitTimeout = setTimeout(() => {
    logger.alert('PANIC BUTTON', 'Mass-close timed out after 10 seconds! Force exiting...');
    process.exit(1);
  }, 10000);
  forceExitTimeout.unref();

  try {
    await massCloseAll();
    clearTimeout(forceExitTimeout);
    
    if (activeTrades.size > 0) {
      logger.warn('PANIC BUTTON', `Failed to close all positions. ${activeTrades.size} positions remain open. Please close them manually:\n` + Array.from(activeTrades.keys()).map(addr => `- ${addr}`).join('\n'));
    } else {
      logger.success('PANIC BUTTON', 'Safe shutdown complete. All positions closed.');
    }
  } catch (err: any) {
    logger.error('PANIC BUTTON', `Error during mass-close: ${err.message || err}`);
  } finally {
    process.exit(0);
  }
});

process.on('unhandledRejection', (err: any) => {
  logger.error('SYSTEM', `Unhandled Promise Rejection: ${err?.message || err}`);
});

main().catch((err) => {
  logger.error('SYSTEM', `Fatal main execution error: ${err?.message || err}`);
});
