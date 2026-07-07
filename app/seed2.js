// AGENTZON SEED ROUND 2: grow the store to 20 genuinely useful skills.
// Reuses the round 1 operators (topped up from the authority) and adds two
// new specialist agents. Run: AGENTZON_RPC="<helius>" node seed2.js
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync, writeFileSync } from "fs";
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
const config = pk([Buffer.from("config")]);

// two more skills for each round 1 agent: the things agents actually need
const MORE_SKILLS = {
  AlphaHunter: [
    { name: "Token Due Diligence Report", price: 30, category: "marketAnalysis" },
    { name: "Price Feed and Chart Data", price: 15, category: "marketAnalysis" },
  ],
  LoreForge: [
    { name: "Docs and README Writer", price: 20, category: "content" },
    { name: "X Thread Ghostwriter", price: 25, category: "content" },
  ],
  TrenchBot: [
    { name: "Wallet Risk Score", price: 20, category: "trading" },
    { name: "Copy Trade Signals", price: 40, category: "trading" },
  ],
  SiteSpinner: [
    { name: "Code Review and Bug Hunt", price: 30, category: "development" },
    { name: "Solana Tx Builder", price: 20, category: "development" },
  ],
  ChainEye: [
    { name: "Web Scraper and Data Extractor", price: 20, category: "data" },
    { name: "RAG Knowledge Retrieval", price: 25, category: "data" },
  ],
  ClipMaker: [
    { name: "Image Generation Broker", price: 30, category: "content" },
    { name: "Meme Factory", price: 15, category: "content" },
  ],
};

// two new specialists
const NEW_AGENTS = [
  { name: "CodeSage", skill: { name: "Debugging Session", price: 35, category: "development" } },
  { name: "Oracle", skill: { name: "Live Web Research", price: 25, category: "data" } },
];

const TOPUP = 0.0095e9;  // skill account rent is ~0.004 SOL each; covers two listings
const NEW_FUND = 0.013e9;

async function transfer(to, lamports) {
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: to, lamports })
  ), [funder]);
}

async function listSkill(op, agentPda, s) {
  const prov = new AnchorProvider(connection, new Wallet(op), { commitment: "confirmed" });
  const reg = new Program(idl("registry"), prov);
  const sid = rand16();
  const skill = pk([Buffer.from("skill"), agentPda.toBuffer(), Buffer.from(sid)]);
  await reg.methods.listSkill(sid, s.name, new BN(s.price), { [s.category]: {} }, "")
    .accountsStrict({ config, agent: agentPda, skill, operator: op.publicKey, systemProgram: SystemProgram.programId }).rpc();
  console.log("listed:", s.name, `(${s.price} $AGENTZON, ${s.category})`);
  return skill.toBase58();
}

(async () => {
  const saved = JSON.parse(readFileSync(join(__dirname, "seed-agents.json"), "utf8"));

  // idempotency: skip skills that already exist onchain for that agent
  const roReg = new Program(idl("registry"), new AnchorProvider(connection, new Wallet(funder), {}));
  const existing = (await roReg.account.skillAccount.all()).map((r) => ({
    agent: r.account.sellerAgent.toBase58(), name: r.account.name,
  }));
  const already = (agent, name) => existing.some((e) => e.agent === agent && e.name === name);

  // round 1 operators: top up + list two more skills each
  for (const entry of saved) {
    const more = (MORE_SKILLS[entry.name] || []).filter((s) => !already(entry.agent, s.name));
    if (!more.length) { console.log(`skip ${entry.name}, nothing new`); continue; }
    const op = Keypair.fromSecretKey(Uint8Array.from(entry.secret));
    await transfer(op.publicKey, TOPUP);
    const agentPda = new PublicKey(entry.agent);
    entry.skills = entry.skills || [entry.skill];
    for (const s of more) entry.skills.push(await listSkill(op, agentPda, s));
    console.log(`-- ${entry.name}: now ${entry.skills.length} skills`);
  }

  // new specialists: fund, register, list
  for (const a of NEW_AGENTS) {
    if (saved.some((e) => e.name === a.name)) { console.log(`skip ${a.name}, exists`); continue; }
    const op = Keypair.generate();
    await transfer(op.publicKey, NEW_FUND);
    const prov = new AnchorProvider(connection, new Wallet(op), { commitment: "confirmed" });
    const reg = new Program(idl("registry"), prov);
    const agentPda = pk([Buffer.from("agent"), op.publicKey.toBuffer()]);
    await reg.methods.registerAgent(rand16(), a.name, "")
      .accountsStrict({ config, agent: agentPda, operator: op.publicKey, systemProgram: SystemProgram.programId }).rpc();
    const skillPk = await listSkill(op, agentPda, a.skill);
    saved.push({ name: a.name, operator: op.publicKey.toBase58(), secret: Array.from(op.secretKey), agent: agentPda.toBase58(), skills: [skillPk] });
    console.log(`-- ${a.name}: registered + listed`);
  }

  writeFileSync(join(__dirname, "seed-agents.json"), JSON.stringify(saved, null, 2));
  console.log("\nSEED ROUND 2 COMPLETE");
})().catch((e) => { console.error("seed2 error:", e?.message || e); process.exit(1); });
