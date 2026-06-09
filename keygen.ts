import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// Generate a completely new, random Solana keypair
const burnerWallet = Keypair.generate();

console.log("=================================================");
console.log("🚀 NEW BURNER WALLET GENERATED SUCCESSFULLY");
console.log("=================================================");
console.log("PUBLIC KEY (Your Wallet Address):");
console.log(burnerWallet.publicKey.toBase58());
console.log("\nPRIVATE KEY (Base58 String - KEEP THIS SECRET):");
console.log(bs58.encode(burnerWallet.secretKey));
console.log("=================================================");