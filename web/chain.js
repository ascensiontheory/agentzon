// AGENTZON browser chain client — wallet-signed writes to the devnet programs.
// Bundled with esbuild into ../site/js/agentzon-chain.js and exposed as window.AGENTZON.
import { Buffer } from "buffer";
if (!globalThis.Buffer) globalThis.Buffer = Buffer;

import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
const TOKEN = TOKEN_2022_PROGRAM_ID; // $AGENTZON is a Token-2022 mint
import registryIdl from "./idl/registry.json";
import escrowIdl from "./idl/escrow.json";

// RPC goes through the same-origin backend proxy so no key ships to the client.
const RPC = (typeof window !== "undefined" ? window.location.origin : "") + "/api/rpc";
const EXPLORER_TX = (s) => `https://explorer.solana.com/tx/${s}`;
const connection = new Connection(RPC, "confirmed");
// The proxy has no websocket, so confirm by polling signature status over http.
connection.confirmTransaction = async (strategy) => {
  const sig = typeof strategy === "string" ? strategy : strategy.signature;
  for (let i = 0; i < 75; i++) {
    const st = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
    const s = st && st.value && st.value.confirmationStatus;
    if (st && st.value && st.value.err) throw new Error("Transaction failed: " + JSON.stringify(st.value.err));
    if (s === "confirmed" || s === "finalized") return { context: st.context, value: st.value };
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Confirmation timed out");
};

function phantom() {
  const p = window.phantom?.solana || window.solana;
  if (!p || !p.isPhantom) throw new Error("Phantom wallet not found — install it from phantom.app");
  return p;
}

function provider() {
  const p = phantom();
  if (!p.publicKey) throw new Error("Wallet not connected");
  const wallet = {
    publicKey: p.publicKey,
    signTransaction: (tx) => p.signTransaction(tx),
    signAllTransactions: (txs) => p.signAllTransactions(txs),
  };
  return new AnchorProvider(connection, wallet, { commitment: "confirmed" });
}

function registry() {
  return new Program(registryIdl, provider());
}
function escrowProgram() {
  return new Program(escrowIdl, provider());
}
const postJson = (path, body) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

const rand16 = () => {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a);
};
const pk = (seeds, pid) => PublicKey.findProgramAddressSync(seeds, pid)[0];

async function connect() {
  const res = await phantom().connect();
  return res.publicKey.toString();
}

function connected() {
  const p = window.phantom?.solana || window.solana;
  return !!(p && p.publicKey);
}

async function registerAgent(name, metadataUri = "") {
  const rg = registry();
  const op = rg.provider.wallet.publicKey;
  const config = pk([Buffer.from("config")], rg.programId);
  const agent = pk([Buffer.from("agent"), op.toBuffer()], rg.programId);
  const sig = await rg.methods
    .registerAgent(rand16(), name, metadataUri)
    .accountsStrict({ config, agent, operator: op, systemProgram: SystemProgram.programId })
    .rpc();
  return { sig, url: EXPLORER_TX(sig), agent: agent.toBase58() };
}

async function listSkill(name, price, category) {
  const rg = registry();
  const op = rg.provider.wallet.publicKey;
  const config = pk([Buffer.from("config")], rg.programId);
  const agent = pk([Buffer.from("agent"), op.toBuffer()], rg.programId);
  const id = rand16();
  const skill = pk([Buffer.from("skill"), agent.toBuffer(), Buffer.from(id)], rg.programId);
  const sig = await rg.methods
    .listSkill(id, name, new BN(price), { [category]: {} }, "")
    .accountsStrict({ config, agent, skill, operator: op, systemProgram: SystemProgram.programId })
    .rpc();
  return { sig, url: EXPLORER_TX(sig), skill: skill.toBase58() };
}

// has this wallet registered an agent yet?
async function hasAgent() {
  const p = window.phantom?.solana || window.solana;
  if (!p?.publicKey) return false;
  const rg = new Program(registryIdl, new AnchorProvider(connection, { publicKey: p.publicKey, signTransaction: async (t) => t, signAllTransactions: async (t) => t }, {}));
  const agent = pk([Buffer.from("agent"), p.publicKey.toBuffer()], rg.programId);
  const info = await connection.getAccountInfo(agent);
  return !!info;
}

// Buy/execute a skill: backend faucets the buyer + ensures the seller account,
// the buyer signs create_escrow, then the protocol authority releases (90/5/5 + burn).
async function executeSkill(skillPubkey) {
  const es = escrowProgram();
  const buyer = es.provider.wallet.publicKey;
  const prep = await postJson("/api/prepare-execute", { skill: skillPubkey, buyer: buyer.toBase58() });
  if (!prep.ok) throw new Error(prep.error || "prepare failed");

  const mint = new PublicKey(prep.mint);
  const execId = rand16();
  const escrow = pk([Buffer.from("escrow"), Buffer.from(execId)], es.programId);
  const config = pk([Buffer.from("config")], es.programId);
  const vault = getAssociatedTokenAddressSync(mint, escrow, true, TOKEN);

  const createSig = await es.methods
    .createEscrow(execId, new BN(prep.price), new BN(3600))
    .accountsStrict({
      config, escrow, vault, mint,
      buyerToken: new PublicKey(prep.buyerToken), sellerToken: new PublicKey(prep.sellerToken), buyer,
      tokenProgram: TOKEN, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();

  const rel = await postJson("/api/release", { escrow: escrow.toBase58(), skill: skillPubkey });
  if (!rel.ok) throw new Error(rel.error || "release failed");
  return { price: prep.price, createSig, releaseSig: rel.sig, url: rel.url };
}

window.AGENTZON = { connect, connected, registerAgent, listSkill, executeSkill, hasAgent, EXPLORER_TX };
