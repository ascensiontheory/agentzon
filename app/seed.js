// AGENTZON SEED: register genuine starter agents + skills on mainnet so the
// marketplace is populated at launch. Run ONCE, AFTER go-live.js.
//   cd /root/agentzon/api && AGENTZON_RPC="<helius>" node seed.js
// Each agent is a real on-chain account; the operator keypairs are saved to
// seed-agents.json so they can be managed / fulfill executions later.
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { webcrypto } from "crypto";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const __dirname = dirname(fileURLToPath(import.meta.url));
const idl = (n) => JSON.parse(readFileSync(join(__dirname, "idl", `${n}.json`), "utf8"));
const RPC = process.env.AGENTZON_RPC || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC, "confirmed");

const funder = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(join(__dirname, "mainnet-authority.json"), "utf8"))));
const registryId = new Program(idl("registry"), new AnchorProvider(connection, new Wallet(funder), {})).programId;
const pk = (seeds) => PublicKey.findProgramAddressSync(seeds, registryId)[0];
const rand16 = () => { const a = new Uint8Array(16); webcrypto.getRandomValues(a); return Array.from(a); };

const AGENTS = [
  { name: "AlphaHunter", skill: { name: "Volume Rotation Detector", price: 25, category: "marketAnalysis" } },
  { name: "LoreForge",   skill: { name: "Memecoin Lore Generator",  price: 15, category: "content" } },
  { name: "TrenchBot",   skill: { name: "Smart Money Tracker",      price: 35, category: "trading" } },
  { name: "SiteSpinner", skill: { name: "Launch Site Builder",      price: 50, category: "development" } },
  { name: "ChainEye",    skill: { name: "Whale Wallet Analyzer",    price: 30, category: "data" } },
  { name: "ClipMaker",   skill: { name: "Promo Video Generator",    price: 40, category: "content" } },
];

const config = pk([Buffer.from("config")]);

(async () => {
  if (!(await connection.getAccountInfo(config))) throw new Error("registry config not found — run go-live.js first.");

  const saved = existsSync(join(__dirname, "seed-agents.json"))
    ? JSON.parse(readFileSync(join(__dirname, "seed-agents.json"), "utf8")) : [];

  for (const a of AGENTS) {
    const op = Keypair.generate();
    // fund the operator enough for rent + fees
    await sendAndConfirmTransaction(connection, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: op.publicKey, lamports: 0.01e9 })
    ), [funder]);

    const prov = new AnchorProvider(connection, new Wallet(op), { commitment: "confirmed" });
    const reg = new Program(idl("registry"), prov);
    const agent = pk([Buffer.from("agent"), op.publicKey.toBuffer()]);
    await reg.methods.registerAgent(rand16(), a.name, "")
      .accountsStrict({ config, agent, operator: op.publicKey, systemProgram: SystemProgram.programId }).rpc();

    const sid = rand16();
    const skill = pk([Buffer.from("skill"), agent.toBuffer(), Buffer.from(sid)]);
    await reg.methods.listSkill(sid, a.skill.name, new BN(a.skill.price), { [a.skill.category]: {} }, "")
      .accountsStrict({ config, agent, skill, operator: op.publicKey, systemProgram: SystemProgram.programId }).rpc();

    saved.push({ name: a.name, operator: op.publicKey.toBase58(), secret: Array.from(op.secretKey), agent: agent.toBase58(), skill: skill.toBase58() });
    console.log("seeded:", a.name, "->", a.skill.name, `(${a.skill.price} $AGENTZON)`);
  }

  writeFileSync(join(__dirname, "seed-agents.json"), JSON.stringify(saved, null, 2));
  console.log(`\nSEED COMPLETE — ${AGENTS.length} agents + skills live on mainnet. Keys saved to seed-agents.json`);
})().catch((e) => { console.error("seed error:", e?.message || e); process.exit(1); });
