import { CONFIG } from './config';

export const COLORS = {
  RESET: '\x1b[0m',
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  BLUE: '\x1b[34m',
  MAGENTA: '\x1b[35m',
  CYAN: '\x1b[36m',
  WHITE: '\x1b[37m',
  GRAY: '\x1b[90m',
  BRIGHT_GREEN: '\x1b[92m',
  BRIGHT_RED: '\x1b[91m',
  BRIGHT_YELLOW: '\x1b[93m',
};

export interface PinnedTradeInfo {
  address: string;
  amountRaw: number;
  entryPriceUsd: number;
  currentPriceUsd: number;
}

let lastPinnedLinesCount = 0;
let currentPinnedBlockText = '';

/**
 * Re-prints the pinned dashboard block at the absolute bottom of the terminal window
 */
export function reprintPinnedBlock() {
  if (lastPinnedLinesCount > 0) {
    // Move cursor up by lastPinnedLinesCount lines to the top of the block
    process.stdout.write(`\x1b[${lastPinnedLinesCount}A`);
    
    // Clear each line moving down without causing standard scroll
    const totalLines = lastPinnedLinesCount + 1;
    for (let i = 0; i < totalLines; i++) {
      process.stdout.write('\r\x1b[K');
      if (i < totalLines - 1) {
        process.stdout.write('\x1b[1B'); // Move cursor down 1 line
      }
    }
    
    // Return cursor up to start of the cleared block
    process.stdout.write(`\x1b[${lastPinnedLinesCount}A\r`);
  } else {
    // Just clear the current single line
    process.stdout.write('\r\x1b[K');
  }
  
  // Print current pinned dashboard text
  process.stdout.write(currentPinnedBlockText);
  
  // Count how many newlines are in the printed block to set new height
  const newlines = (currentPinnedBlockText.match(/\n/g) || []).length;
  lastPinnedLinesCount = newlines;
}

/**
 * Updates the pinned active positions and P&L summary
 */
export function updatePinnedDashboard(
  trades: PinnedTradeInfo[],
  realizedUsd: number,
  sessionRealizedUsd: number,
  totalFeesUsd: number,
  walletBalanceSol: number
) {
  let unrealize = 0;
  
  for (const trade of trades) {
    const entryValue = CONFIG.ENTRY_SIZE_USD;
    const currentValue = (trade.currentPriceUsd / trade.entryPriceUsd) * entryValue;
    unrealize += (currentValue - entryValue);
  }
  
  const realise = sessionRealizedUsd;
  const net = unrealize + realise;
  const fee = totalFeesUsd;
  const totalPnL = realizedUsd + unrealize - totalFeesUsd;
  
  const unrealizeColor = unrealize >= 0 ? COLORS.BRIGHT_GREEN : COLORS.BRIGHT_RED;
  const unrealizeSign = unrealize >= 0 ? '+' : '';
  
  const realiseColor = realise >= 0 ? COLORS.BRIGHT_GREEN : COLORS.BRIGHT_RED;
  const realiseSign = realise >= 0 ? '+' : '';
  
  const netColor = net >= 0 ? COLORS.BRIGHT_GREEN : COLORS.BRIGHT_RED;
  const netSign = net >= 0 ? '+' : '';
  
  const feeColor = COLORS.YELLOW;
  
  const totalColor = totalPnL >= 0 ? COLORS.BRIGHT_GREEN : COLORS.BRIGHT_RED;
  const totalSign = totalPnL >= 0 ? '+' : '';
  
  const text = `Open: ${COLORS.WHITE}${trades.length}${COLORS.RESET} | Unrealize: ${unrealizeColor}${unrealizeSign}$${unrealize.toFixed(2)}${COLORS.RESET} | Realise: ${realiseColor}${realiseSign}$${realise.toFixed(2)}${COLORS.RESET} | Net: ${netColor}${netSign}$${net.toFixed(2)}${COLORS.RESET} | Fee: ${feeColor}$${fee.toFixed(2)}${COLORS.RESET} | Total PnL: ${totalColor}${totalSign}$${totalPnL.toFixed(2)}${COLORS.RESET} | Balance: ${COLORS.BRIGHT_YELLOW}${walletBalanceSol.toFixed(4)} SOL${COLORS.RESET}\n`;
  
  currentPinnedBlockText = text;
  reprintPinnedBlock();
}

function getFormattedTime(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `[${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}]`;
}

/**
 * Prints a log message to console, preserving the pinned dashboard at the bottom
 */
export function log(message: string) {
  if (lastPinnedLinesCount > 0) {
    // Move cursor up by lastPinnedLinesCount lines to the top of the block
    process.stdout.write(`\x1b[${lastPinnedLinesCount}A`);
    
    // Clear each line moving down without causing standard scroll
    const totalLines = lastPinnedLinesCount + 1;
    for (let i = 0; i < totalLines; i++) {
      process.stdout.write('\r\x1b[K');
      if (i < totalLines - 1) {
        process.stdout.write('\x1b[1B'); // Move cursor down 1 line
      }
    }
    
    // Return cursor up to start of the cleared block
    process.stdout.write(`\x1b[${lastPinnedLinesCount}A\r`);
  } else {
    // Just clear the current single line
    process.stdout.write('\r\x1b[K');
  }
  
  // Print the log message followed by a newline (this may scroll the terminal, which is correct)
  const timestamp = getFormattedTime();
  process.stdout.write(`${COLORS.GRAY}${timestamp}${COLORS.RESET} ${message}\n`);
  
  // Reprint the current pinned block immediately below
  process.stdout.write(currentPinnedBlockText);
}

/**
 * Helper to format logs with standard tags and colors
 */
export const logger = {
  info: (tag: string, msg: string) => {
    log(`${COLORS.BLUE}[${tag}]${COLORS.RESET} ${msg}`);
  },
  success: (tag: string, msg: string) => {
    log(`${COLORS.GREEN}[${tag}]${COLORS.RESET} ${msg}`);
  },
  warn: (tag: string, msg: string) => {
    log(`${COLORS.YELLOW}[${tag}]${COLORS.RESET} ${msg}`);
  },
  error: (tag: string, msg: string) => {
    log(`${COLORS.RED}[${tag}]${COLORS.RESET} ${msg}`);
  },
  alert: (tag: string, msg: string) => {
    log(`${COLORS.BRIGHT_RED}[${tag}]${COLORS.RESET} ${msg}`);
  },
  paper: (tag: string, msg: string) => {
    log(`${COLORS.MAGENTA}[${tag}]${COLORS.RESET} ${msg}`);
  },
  raw: (msg: string) => {
    log(msg);
  }
};
