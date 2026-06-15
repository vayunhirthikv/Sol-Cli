import { Connection, Keypair, PublicKey, VersionedTransaction, TransactionMessage, AddressLookupTableAccount, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createCloseAccountInstruction, createBurnInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import axios from 'axios';
import bs58 from 'bs58';
import { CONFIG } from './config';
import { logger } from './logger';

const connection = new Connection(CONFIG.RPC_URL, {
  commitment: 'confirmed',
  wsEndpoint: CONFIG.ALCHEMY_WS_URL,
});
let wallet: Keypair;
try {
  wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.WALLET_PRIVATE_KEY));
} catch (e) {
  if (CONFIG.PAPER_TRADE) {
    logger.warn('EXECUTOR', 'Invalid WALLET_PRIVATE_KEY provided, using a random mock wallet for PAPER TRADE.');
    wallet = Keypair.generate();
  } else {
    throw e;
  }
}
const WSOL_ADDRESS = 'So11111111111111111111111111111111111111112';

export let cachedSolPrice = 150;

export async function fetchSolPriceBg() {
  try {
    const headers: Record<string, string> = {};
    if (CONFIG.JUPITER_API_KEY) {
      headers['x-api-key'] = CONFIG.JUPITER_API_KEY;
    }
    const res = await axios.get(`https://api.jup.ag/price/v2?ids=${WSOL_ADDRESS}`, { headers });
    const price = parseFloat(res.data?.data?.[WSOL_ADDRESS]?.price);
    if (price > 0) {
      cachedSolPrice = price;
    }
  } catch (e) {
    // Ignore and keep using previous cached value
  }
}

/**
 * Execute a Buy Order
 */
export async function executeBuy(tokenAddress: string, amountUsd: number) {
  try {
    // Paper Trade: skip Jupiter entirely, just simulate the buy
    if (CONFIG.PAPER_TRADE) {
      logger.paper('EXECUTOR', `[PAPER BUY] Simulated buy of $${amountUsd} of ${tokenAddress}`);
      return `paper_buy_${Date.now()}`;
    }

    // Use background polled SOL price to calculate exact lamports
    const lamports = Math.floor((amountUsd / cachedSolPrice) * 1e9);

    logger.info('EXECUTOR', `Executing Buy: ${lamports} lamports of ${tokenAddress} (SOL price: $${cachedSolPrice.toFixed(2)})`);
    return await executeSwapInstructions(WSOL_ADDRESS, tokenAddress, lamports, false);
  } catch (err: any) {
    logger.error('EXECUTOR', 'Buy failed: ' + err.message);
    return null;
  }
}

/**
 * Execute a Sell Order (Exit)
 * Includes rent recovery instruction
 */
export async function executeSell(tokenAddress: string, tokenAmountRaw: number): Promise<{ txHash: string; isBurn: boolean } | null> {
  try {
    // Paper Trade: skip Jupiter entirely, just simulate the sell
    if (CONFIG.PAPER_TRADE) {
      logger.paper('EXECUTOR', `[PAPER SELL] Simulated sell of ${tokenAddress}`);
      return { txHash: `paper_sell_${Date.now()}`, isBurn: false };
    }

    if (tokenAmountRaw <= 0) {
      logger.warn('EXECUTOR', `Sell amount for ${tokenAddress} is 0. Skipping on-chain transaction.`);
      return null;
    }

    logger.info('EXECUTOR', `Executing Exit (Sell): ${tokenAmountRaw} raw of ${tokenAddress}`);
    try {
      const txHash = await executeSwapInstructions(tokenAddress, WSOL_ADDRESS, tokenAmountRaw, true);
      return { txHash, isBurn: false };
    } catch (swapErr: any) {
      const errMsg = swapErr.message || "";
      if (errMsg.includes("COULD_NOT_FIND_ANY_ROUTE") || errMsg.includes("route not found")) {
        logger.alert('EXECUTOR', `No liquidity route found. Initiating native SOL fallback (Burn & Close) for ${tokenAddress}...`);
        const txHash = await executeBurnAndClose(tokenAddress, tokenAmountRaw);
        return txHash ? { txHash, isBurn: true } : null;
      }
      throw swapErr;
    }
  } catch (err: any) {
    logger.error('EXECUTOR', 'Sell failed: ' + err.message);
    return null;
  }
}

/**
 * Core Execution Engine utilizing Jupiter /swap-instructions and RPCFast
 */
async function executeSwapInstructions(inputMint: string, outputMint: string, amount: number, isSell: boolean) {
  try {
    const headers: Record<string, string> = {};
    if (CONFIG.JUPITER_API_KEY) {
      headers['x-api-key'] = CONFIG.JUPITER_API_KEY;
    }

    const slippage = isSell ? CONFIG.EXIT_SLIPPAGE_BPS : CONFIG.SLIPPAGE_BPS;

    // 1. Get Quote (Updated to new v6 endpoint)
    const quoteResponse = await axios.get(`https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippage}`, { headers });
    const quote = quoteResponse.data;

    // 2. Get Instructions (Updated to new v6 endpoint)
    const priorityFee = CONFIG.PRIORITY_FEE_MODE === 'auto' ? 'auto' : Number(CONFIG.PRIORITY_FEE_MODE);
    const instructionsReq = await axios.post('https://quote-api.jup.ag/v6/swap-instructions', {
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: isNaN(priorityFee as any) ? 'auto' : priorityFee,
    }, { headers });

    const {
      tokenLedgerInstruction,
      computeBudgetInstructions,
      setupInstructions,
      swapInstruction,
      cleanupInstruction,
      addressLookupTableAddresses,
    } = instructionsReq.data;

    const deserializeInstruction = (ix: any) => new TransactionInstruction({
      programId: new PublicKey(ix.programId),
      keys: ix.accounts.map((acc: any) => ({
        pubkey: new PublicKey(acc.pubkey),
        isSigner: acc.isSigner,
        isWritable: acc.isWritable,
      })),
      data: Buffer.from(ix.data, "base64"),
    });

    const allInstructions: TransactionInstruction[] = [];

    // Add Compute Budget
    if (computeBudgetInstructions) {
      computeBudgetInstructions.forEach((ix: any) => allInstructions.push(deserializeInstruction(ix)));
    }

    // Add Token Ledger (Crucial for certain Jupiter routes)
    if (tokenLedgerInstruction) {
      allInstructions.push(deserializeInstruction(tokenLedgerInstruction));
    }

    // Add Setup
    if (setupInstructions) {
      setupInstructions.forEach((ix: any) => allInstructions.push(deserializeInstruction(ix)));
    }

    // Add Swap
    if (swapInstruction) allInstructions.push(deserializeInstruction(swapInstruction));

    // Add Cleanup (unwrap SOL)
    if (cleanupInstruction) allInstructions.push(deserializeInstruction(cleanupInstruction));


    // 3. Address Lookup Tables (ALT)
    const getAddressLookupTableAccounts = async (keys: string[]) => {
      const altAccounts = await Promise.all(
        keys.map(key => connection.getAddressLookupTable(new PublicKey(key)))
      );
      return altAccounts.map(res => res.value).filter(val => val !== null) as AddressLookupTableAccount[];
    };

    const lookupTableAccounts = await getAddressLookupTableAccounts(addressLookupTableAddresses);

    // 4. Compile Versioned Transaction (v0)
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: allInstructions,
    }).compileToV0Message(lookupTableAccounts);

    const tx = new VersionedTransaction(messageV0);
    tx.sign([wallet]);

    // 5. Blast to RPCFast (Action Layer)
    if (CONFIG.PAPER_TRADE) {
      logger.paper('EXECUTOR', `Bypassing on-chain execution for ${isSell ? 'SELL' : 'BUY'}`);
      return `paper_tx_${Math.random().toString(36).substr(2, 9)}`;
    }

    const txHash = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 2,
    });

    return txHash;

  } catch (err: any) {
    let errMsg = err.message;
    if (err.response?.data) {
      const respData = JSON.stringify(err.response.data);
      errMsg = `${err.message} - ${respData}`;
      if (respData.includes("COULD_NOT_FIND_ANY_ROUTE") || respData.includes("route not found") || respData.includes("errorCode")) {
        logger.alert('EXECUTOR', `CRITICAL: No liquidity route found on Jupiter for ${inputMint}. Token has likely been rugged or has zero liquidity pools!`);
      }
    }
    logger.error('EXECUTOR', `Swap-Instructions failed: ${errMsg}`);
    throw new Error(errMsg);
  }
}

/**
 * Get the wallet's token balance (raw/integer amount) with retries
 */
export async function getWalletTokenBalance(tokenAddress: string): Promise<number> {
  if (CONFIG.PAPER_TRADE) {
    return 0;
  }

  try {
    const mintPubkey = new PublicKey(tokenAddress);
    const ata = getAssociatedTokenAddressSync(mintPubkey, wallet.publicKey);

    return new Promise<number>((resolve) => {
      let resolved = false;

      // 1. Subscribe to Account Changes (Sub-millisecond confirmation via Alchemy WebSocket)
      const subId = connection.onAccountChange(
        ata,
        (accountInfo) => {
          try {
            if (accountInfo.data && accountInfo.data.length >= 72) {
              const amountRaw = Number(accountInfo.data.readBigUInt64LE(64));
              if (amountRaw > 0 && !resolved) {
                resolved = true;
                connection.removeAccountChangeListener(subId);
                resolve(amountRaw);
              }
            }
          } catch (err) {
            // Ignore parse errors
          }
        },
        'confirmed'
      );

      // 2. Fallback: If no socket update within 5 seconds, query balance once and resolve
      setTimeout(async () => {
        if (!resolved) {
          resolved = true;
          connection.removeAccountChangeListener(subId);
          try {
            const balanceInfo = await connection.getTokenAccountBalance(ata, 'confirmed');
            resolve(Number(balanceInfo.value.amount));
          } catch (e) {
            resolve(0);
          }
        }
      }, 5000);
    });
  } catch (err: any) {
    logger.error('EXECUTOR', `Failed to subscribe to balance for ${tokenAddress}: ${err.message}`);
  }
  return 0;
}

/**
 * Check if the wallet has enough SOL to trade
 */
export async function checkWalletSOLBalance(): Promise<boolean> {
  if (CONFIG.PAPER_TRADE) {
    logger.paper('EXECUTOR', 'Wallet Balance: Simulated PAPER TRADE wallet (Infinite SOL)');
    return true; 
  }

  try {
    const balance = await connection.getBalance(wallet.publicKey, 'confirmed');
    const balanceSol = balance / 1e9;
    logger.info('EXECUTOR', `Wallet Balance: ${balanceSol.toFixed(4)} SOL`);
    
    if (balanceSol < CONFIG.MIN_SOL_BALANCE) {
      logger.warn('EXECUTOR', `Wallet SOL balance (${balanceSol.toFixed(4)} SOL) is below the minimum threshold (${CONFIG.MIN_SOL_BALANCE} SOL).`);
      return false;
    }
    return true;
  } catch (err: any) {
    logger.error('EXECUTOR', `Failed to check wallet balance: ${err.message}`);
    return false;
  }
}

/**
 * Fallback to burn worthless tokens and close the account to recover rent (~0.002 SOL)
 */
export async function executeBurnAndClose(tokenAddress: string, amountRaw: number): Promise<string | null> {
  try {
    logger.alert('EXECUTOR', `Initiating Burn & Close for rugged token: ${tokenAddress} (Amount: ${amountRaw})`);

    if (CONFIG.PAPER_TRADE) {
      logger.paper('EXECUTOR', 'Bypassing on-chain Burn & Close');
      return `paper_burn_close_${Date.now()}`;
    }

    const mintPubkey = new PublicKey(tokenAddress);
    const ata = getAssociatedTokenAddressSync(mintPubkey, wallet.publicKey);

    const instructions: TransactionInstruction[] = [];

    // 1. Create burn instruction (only if we have tokens to burn)
    if (amountRaw > 0) {
      const burnIx = createBurnInstruction(
        ata,
        mintPubkey,
        wallet.publicKey,
        amountRaw
      );
      instructions.push(burnIx);
    }

    // 2. Create close account instruction (always close to recover rent)
    const closeIx = createCloseAccountInstruction(
      ata,
      wallet.publicKey, // rent recipient
      wallet.publicKey, // owner
      []
    );
    instructions.push(closeIx);

    // 3. Compile atomic transaction
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: instructions,
    }).compileToV0Message([]);

    const tx = new VersionedTransaction(messageV0);
    tx.sign([wallet]);

    // 4. Send transaction
    const txHash = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 2,
    });

    logger.success('EXECUTOR', `Rug Recovery Successful! Closed account ${ata.toBase58()}. TX: ${txHash}`);
    return txHash;
  } catch (err: any) {
    logger.error('EXECUTOR', `Burn & Close failed for ${tokenAddress}: ${err.message}`);
    return null;
  }
}

/**
 * Helper to fetch the actual transaction fee from on-chain receipt,
 * or return a simulated fee in paper trading.
 */
export async function getTransactionFeeUsd(txHash: string): Promise<number> {
  if (CONFIG.PAPER_TRADE || !txHash || txHash.startsWith('paper_')) {
    // Simulated swap transaction fee: 0.00005 SOL
    return 0.00005 * cachedSolPrice;
  }
  try {
    // Wait for confirmation up to 15 seconds
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction({
      signature: txHash,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    }, 'confirmed');
    
    // Fetch transaction details
    const txDetails = await connection.getTransaction(txHash, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });
    if (txDetails && txDetails.meta) {
      const feeLamports = txDetails.meta.fee;
      const feeUsd = (feeLamports / 1e9) * cachedSolPrice;
      return feeUsd;
    }
  } catch (err: any) {
    logger.warn('EXECUTOR', `Failed to fetch actual fee for ${txHash}: ${err.message}. Using default fallback fee.`);
  }
  // Fallback: 0.00005 SOL in USD
  return 0.00005 * cachedSolPrice;
}

/**
 * Fetch the current SOL balance of the wallet
 */
export async function getWalletSOLBalance(): Promise<number> {
  if (CONFIG.PAPER_TRADE) {
    return 10.0; // Return a stable mock balance for paper trading
  }
  try {
    const balance = await connection.getBalance(wallet.publicKey, 'confirmed');
    return balance / 1e9;
  } catch (err: any) {
    logger.error('EXECUTOR', `Failed to fetch wallet SOL balance: ${err.message}`);
    return 0;
  }
}

/**
 * Confirm a transaction landed successfully on-chain.
 * Returns true if confirmed without error, false otherwise.
 */
export async function confirmTransactionHash(txHash: string): Promise<boolean> {
  if (CONFIG.PAPER_TRADE || txHash.startsWith('paper_')) return true;
  try {
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    const result = await connection.confirmTransaction({
      signature: txHash,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    }, 'confirmed');
    return !result.value.err;
  } catch (err: any) {
    logger.error('EXECUTOR', `Transaction confirmation failed for ${txHash}: ${err.message}`);
    return false;
  }
}

/**
 * Close a token account if it has zero balance, recovering ~0.002 SOL rent.
 * Best-effort — failures are logged but do not throw.
 */
export async function closeTokenAccountIfEmpty(tokenAddress: string): Promise<void> {
  if (CONFIG.PAPER_TRADE) return;
  try {
    const mintPubkey = new PublicKey(tokenAddress);
    const ata = getAssociatedTokenAddressSync(mintPubkey, wallet.publicKey, false, TOKEN_PROGRAM_ID);

    const balanceInfo = await connection.getTokenAccountBalance(ata, 'confirmed');
    const balance = Number(balanceInfo.value.amount);

    if (balance === 0) {
      const closeIx = createCloseAccountInstruction(ata, wallet.publicKey, wallet.publicKey, []);
      const latestBlockhash = await connection.getLatestBlockhash('confirmed');
      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [closeIx],
      }).compileToV0Message([]);
      const tx = new VersionedTransaction(messageV0);
      tx.sign([wallet]);
      await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
      logger.info('EXECUTOR', `[RENT] Recovered rent for ${tokenAddress}`);
    } else {
      logger.warn('EXECUTOR', `[RENT] Token account for ${tokenAddress} has ${balance} dust remaining. Skipping rent recovery.`);
    }
  } catch (err: any) {
    logger.warn('EXECUTOR', `[RENT] Failed to recover rent for ${tokenAddress}: ${err.message}`);
  }
}
