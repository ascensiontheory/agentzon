// AGENTZON GO-LIVE: initialize the mainnet program configs against real $AGENTZON.
// Run this ONCE, right after the $AGENTZON token is minted on mainnet:
//   cd /root/agentzon/api && AGENTZON_RPC="<helius>" \
//     AGENTZON_MINT="<new $AGENTZON CA>" AGENTZON_TREASURY="<treasury owner wallet>" node go-live.js
// Idempotent: safe to re-run; skips any config that already exists.
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
const TOKEN = TOKEN_2022_PROGRAM_ID; // $AGENTZON is a Token-2022 mint
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const { AnchorProvider, Program, Wallet } = anchor;
const __dirname = dirname(fileURLToPath(import.meta.url));
const idl = (n) => JSON.parse(readFileSync(join(__dirname, "idl", `${n}.json`), "utf8"));

const RPC = process.env.AGENTZON_RPC || "https://api.mainnet-beta.solana.com";
// New token + wallets are supplied at launch via env — no stale addresses baked in.
if (!process.env.AGENTZON_MINT) throw new Error("set AGENTZON_MINT to the new $AGENTZON contract address");
if (!process.env.AGENTZON_TREASURY) throw new Error("set AGENTZON_TREASURY to the protocol-fee (treasury) owner wallet");
const MINT = new PublicKey(process.env.AGENTZON_MINT); // $AGENTZON (Token-2022)
const TREASURY_OWNER = new PublicKey(process.env.AGENTZON_TREASURY); // protocol-fee wallet (user safe)

const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(join(__dirname, "mainnet-authority.json"), "utf8"))));
const connection = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(authority), { commitment: "confirmed" });

const registry = new Program(idl("registry"), provider);
const escrow = new Program(idl("escrow"), provider);
const governance = new Program(idl("governance"), provider);
const pda = (seeds, pid) => PublicKey.findProgramAddressSync(seeds, pid)[0];
const exists = async (pk) => !!(await connection.getAccountInfo(pk));

(async () => {
  console.log("authority:", authority.publicKey.toBase58());
  console.log("mint:     ", MINT.toBase58());

  if (!(await exists(MINT))) throw new Error("$AGENTZON mint not found on this cluster yet. Mint the token first, then re-run.");

  const treasury = await getOrCreateAssociatedTokenAccount(connection, authority, MINT, TREASURY_OWNER, false, "confirmed", undefined, TOKEN);
  console.log("treasury: ", treasury.address.toBase58(), "(fees flow to your safe wallet)");

  const regConfig = pda([Buffer.from("config")], registry.programId);
  if (await exists(regConfig)) console.log("registry config: already initialized");
  else {
    await registry.methods.initialize(treasury.address, MINT)
      .accountsStrict({ config: regConfig, authority: authority.publicKey, systemProgram: SystemProgram.programId }).rpc();
    console.log("registry config: initialized");
  }

  const escConfig = pda([Buffer.from("config")], escrow.programId);
  if (await exists(escConfig)) console.log("escrow config: already initialized");
  else {
    await escrow.methods.initialize(treasury.address)
      .accountsStrict({ config: escConfig, mint: MINT, authority: authority.publicKey, systemProgram: SystemProgram.programId }).rpc();
    console.log("escrow config: initialized");
  }

  const govConfig = pda([Buffer.from("config")], governance.programId);
  if (await exists(govConfig)) console.log("governance config: already initialized");
  else {
    const vault = getAssociatedTokenAddressSync(MINT, govConfig, true, TOKEN);
    await governance.methods.initialize()
      .accountsStrict({ config: govConfig, mint: MINT, vault, authority: authority.publicKey, tokenProgram: TOKEN, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc();
    console.log("governance config: initialized");
  }

  console.log("\nGO-LIVE COMPLETE — the marketplace is now configured on mainnet and fully operational.");
})().catch((e) => { console.error("go-live error:", e?.message || e); process.exit(1); });
