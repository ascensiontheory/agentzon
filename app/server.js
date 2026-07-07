// AGENTZON backend — serves live on-chain state from the devnet programs.
// Read-only: uses Anchor with a throwaway wallet (no signing).
import express from "express";
import cors from "cors";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
const TOKEN = TOKEN_2022_PROGRAM_ID; // $AGENTZON is a Token-2022 mint
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { setupMcp } from "./mcp.js";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const __dirname = dirname(fileURLToPath(import.meta.url));
const idl = (n) => JSON.parse(readFileSync(join(__dirname, "idl", `${n}.json`), "utf8"));

const RPC = process.env.AGENTZON_RPC || "https://api.mainnet-beta.solana.com";
const PORT = process.env.PORT || 8793;
const CLUSTER = "mainnet";

const connection = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(Keypair.generate()), { commitment: "confirmed" });

const registry = new Program(idl("registry"), provider);
const escrow = new Program(idl("escrow"), provider);
const governance = new Program(idl("governance"), provider);

const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const registryConfigPda = pda([Buffer.from("config")], registry.programId);
const govConfigPda = pda([Buffer.from("config")], governance.programId);
const escrowConfigPda = pda([Buffer.from("config")], escrow.programId);

// Devnet-only authority: enables the demo buyer/execute loop (faucet + escrow release).
// MAINNET: replace with a delivery-gated release service; never expose this key.
let authority = null, escrowW = null, registryW = null;
const AUTH_PATH = process.env.AUTHORITY_KEYPAIR || join(__dirname, "mainnet-authority.json");
if (existsSync(AUTH_PATH)) {
  authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(AUTH_PATH, "utf8"))));
  const wprov = new AnchorProvider(connection, new Wallet(authority), { commitment: "confirmed" });
  escrowW = new Program(idl("escrow"), wprov);
  registryW = new Program(idl("registry"), wprov);
  console.log("authority loaded:", authority.publicKey.toBase58());
}

let ESC_CFG = null;
async function escConfig() {
  if (!ESC_CFG) ESC_CFG = await escrow.account.escrowConfig.fetch(escrowConfigPda);
  return ESC_CFG;
}

const enumKey = (e) => (e && typeof e === "object" ? Object.keys(e)[0] : String(e));
const n = (v) => (BN.isBN(v) ? v.toString() : v);

// ---- tiny TTL cache to spare the public devnet RPC ----
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

async function getStats() {
  return cached("stats", 15000, async () => {
    const [rc, gc] = await Promise.all([
      registry.account.config.fetchNullable(registryConfigPda),
      governance.account.govConfig.fetchNullable(govConfigPda),
    ]);
    return {
      agents: rc ? Number(rc.totalAgents) : 0,
      skills: rc ? Number(rc.totalSkills) : 0,
      totalStaked: gc ? n(gc.totalStaked) : "0",
      proposals: gc ? Number(gc.proposalCount) : 0,
      initialized: !!rc,
    };
  });
}

// curated product blurbs merged onto listings (site, REST and MCP all inherit them)
let SKILL_META = { byName: {} };
try { SKILL_META = JSON.parse(readFileSync(join(__dirname, "skill-meta.json"), "utf8")); } catch (_) {}

async function getSkills() {
  return cached("skills", 15000, async () => {
    const rows = await registry.account.skillAccount.all();
    return rows.map((r) => ({
      pubkey: r.publicKey.toBase58(),
      sellerAgent: r.account.sellerAgent.toBase58(),
      name: r.account.name,
      description: SKILL_META.byName[r.account.name] || null,
      price: n(r.account.price),
      category: enumKey(r.account.category),
      executions: Number(r.account.executionCount),
      ratingCount: Number(r.account.ratingCount),
      totalRating: Number(r.account.totalRating),
      status: enumKey(r.account.status),
      listedAt: Number(r.account.listedAt),
    }));
  });
}

async function getAgents() {
  return cached("agents", 15000, async () => {
    const rows = await registry.account.agentAccount.all();
    return rows.map((r) => ({
      pubkey: r.publicKey.toBase58(),
      operator: r.account.operator.toBase58(),
      name: r.account.name,
      reputation: Number(r.account.reputationScore) / 100,
      executions: Number(r.account.totalExecutions),
      earnings: n(r.account.totalEarnings),
      staked: n(r.account.stakedAmount),
      status: enumKey(r.account.status),
    }));
  });
}

const app = express();
app.use(cors());

app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    cluster: CLUSTER,
    execute: !!authority,
    programs: {
      registry: registry.programId.toBase58(),
      escrow: escrow.programId.toBase58(),
      governance: governance.programId.toBase58(),
    },
  })
);

const handler = (fn) => async (_req, res) => {
  try {
    res.json(await fn());
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: String(e?.message || e) });
  }
};

app.get("/api/stats", handler(getStats));
app.get("/api/skills", handler(getSkills));
app.get("/api/agents", handler(getAgents));

// ---- write helpers for the demo buyer/execute loop (authority-signed) ----
app.use(express.json());

// faucet is devnet-only; on mainnet buyers acquire $AGENTZON on the open market
app.post("/api/faucet", async (_req, res) =>
  res.status(410).json({ error: "faucet is not available on mainnet; acquire $AGENTZON on the open market" })
);

// ensure the seller and buyer token accounts exist. Buyer must already hold $AGENTZON.
// Shared by the REST route and the MCP build_execute_skill_tx tool.
async function prepareExecute(skillStr, buyerStr) {
  if (!authority) throw new Error("execute unavailable");
  const skillPk = new PublicKey(skillStr);
  const skillAcct = await registry.account.skillAccount.fetch(skillPk);
  const price = Number(skillAcct.price);
  const agentAcct = await registry.account.agentAccount.fetch(skillAcct.sellerAgent);
  const { mint } = await escConfig();
  const sellerAta = await getOrCreateAssociatedTokenAccount(connection, authority, mint, agentAcct.operator, false, "confirmed", undefined, TOKEN);
  const buyerAta = await getOrCreateAssociatedTokenAccount(connection, authority, mint, new PublicKey(buyerStr), false, "confirmed", undefined, TOKEN);
  return {
    mint: mint.toBase58(), price,
    sellerToken: sellerAta.address.toBase58(), buyerToken: buyerAta.address.toBase58(),
    sellerAgent: skillAcct.sellerAgent.toBase58(), sellerOperator: agentAcct.operator.toBase58(),
  };
}
app.post("/api/prepare-execute", async (req, res) => {
  try {
    const r = await prepareExecute(req.body?.skill, req.body?.buyer);
    res.json({ ok: true, mint: r.mint, price: r.price, sellerToken: r.sellerToken, buyerToken: r.buyerToken });
  } catch (e) { res.status(502).json({ error: String(e?.message || e) }); }
});

// release a funded escrow: 90% seller / 5% treasury / 5% burn
// Shared by the REST route and the MCP release_escrow tool.
async function releaseEscrowFlow(escrowStr, skillStr) {
  if (!authority) throw new Error("release unavailable");
  const ePk = new PublicKey(escrowStr);
  const eAcct = await escrow.account.escrowAccount.fetch(ePk);
  const cfg = await escConfig();
  const mint = eAcct.mint;
  const vault = getAssociatedTokenAddressSync(mint, ePk, true, TOKEN);
  const sig = await escrowW.methods.releaseEscrow().accountsStrict({
    config: escrowConfigPda, escrow: ePk, vault,
    sellerToken: eAcct.sellerToken, treasuryToken: cfg.treasury, mint,
    authority: authority.publicKey, tokenProgram: TOKEN,
  }).rpc();

  // bump seller reputation + skill execution count (best-effort)
  let repSig = null;
  if (skillStr) {
    try {
      const skillPk = new PublicKey(skillStr);
      const skillAcct = await registry.account.skillAccount.fetch(skillPk);
      repSig = await registryW.methods
        .updateReputation(true, null, eAcct.sellerShare)
        .accountsStrict({ config: registryConfigPda, agent: skillAcct.sellerAgent, skill: skillPk, authority: authority.publicKey })
        .rpc();
    } catch (e) { console.warn("update_reputation:", e?.message || e); }
  }
  cache.delete("skills"); cache.delete("agents"); // reflect new counts on next fetch
  return { sig, repSig, url: `https://explorer.solana.com/tx/${sig}` };
}
app.post("/api/release", async (req, res) => {
  try {
    const r = await releaseEscrowFlow(req.body?.escrow, req.body?.skill);
    res.json({ ok: true, ...r, via: "Executed via Agentzon, the everything store for AI agents. List your own skills or hire other agents: https://agentzon.xyz/mcp" });
  } catch (e) { res.status(502).json({ error: String(e?.message || e) }); }
});

// same-origin RPC proxy so the browser never sees the Helius key
app.post("/api/rpc", async (req, res) => {
  try {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req.body) });
    const text = await r.text();
    res.status(r.status).type("application/json").send(text);
  } catch (e) { res.status(502).json({ error: String(e?.message || e) }); }
});

// ---- the machine door: manifest + IDLs for agents that self onboard ----
const MINT_CA = "iuajEnHJFP3W1tZX8WFe8d9o8mz51rhtDwPMMzcpump";
function buildManifest(stats) {
  return {
    mcp: {
      endpoint: "https://agentzon.xyz/mcp",
      transport: "streamable-http",
      add_with_claude_code: "claude mcp add --transport http agentzon https://agentzon.xyz/mcp",
      note: "The whole marketplace as tools. Write actions return unsigned transactions you sign locally; keys never leave your machine.",
    },
    name: "Agentzon",
    description: "The everything store for AI agents. Agents register, list skills and hire each other on Solana mainnet, settling in $AGENTZON.",
    site: "https://agentzon.xyz",
    agent_portal: "https://agentzon.xyz/agent",
    docs: "https://agentzon.xyz/docs",
    llms_txt: "https://agentzon.xyz/llms.txt",
    repository: "https://github.com/ascensiontheory/agentzon",
    x: "https://x.com/Agentzon",
    chain: "solana",
    cluster: "mainnet-beta",
    token: { symbol: "AGENTZON", mint: MINT_CA, standard: "token-2022", decimals: 6, launchpad: "pump.fun" },
    packages: { npm: "agentzon", pypi: "agentzon" },
    programs: {
      registry: registry.programId.toBase58(),
      escrow: escrow.programId.toBase58(),
      governance: governance.programId.toBase58(),
    },
    fees: { seller: "90%", treasury: "5%", burned: "5%" },
    api: {
      base: "https://agentzon.xyz/api",
      endpoints: [
        { method: "GET", path: "/api/health", description: "Service health and program ids" },
        { method: "GET", path: "/api/stats", description: "Live marketplace totals" },
        { method: "GET", path: "/api/skills", description: "All onchain skill listings" },
        { method: "GET", path: "/api/agents", description: "All registered agents" },
        { method: "GET", path: "/api/idl/{registry|escrow|governance}", description: "Anchor IDL with program address embedded" },
        { method: "POST", path: "/api/rpc", description: "Key free JSON RPC proxy to Solana mainnet, http only" },
        { method: "POST", path: "/api/prepare-execute", description: "Prepare a skill purchase. Body {skill, buyer}. Returns mint, price and token accounts" },
        { method: "POST", path: "/api/release", description: "Release a funded escrow. Body {escrow, skill}. Splits 90/5/5 and burns 5%" },
      ],
    },
    pda_seeds: {
      config: ["config"],
      agent: ["agent", "operator_pubkey"],
      skill: ["skill", "agent_pda", "skill_id_16_bytes"],
      escrow: ["escrow", "execution_id_16_bytes"],
      stake: ["stake", "staker_pubkey"],
      proposal: ["proposal", "proposal_id_16_bytes"],
      vote: ["vote", "proposal_pda", "voter_pubkey"],
    },
    stats,
    updated: new Date().toISOString(),
  };
}
app.get("/api/agent/manifest", async (_req, res) => {
  let stats = null;
  try { stats = await getStats(); } catch (_) {}
  res.json(buildManifest(stats));
});

const IDL_NAMES = new Set(["registry", "escrow", "governance"]);
app.get("/api/idl/:name", (req, res) => {
  const n = String(req.params.name || "").toLowerCase();
  if (!IDL_NAMES.has(n)) return res.status(404).json({ error: "unknown idl; use registry, escrow or governance" });
  res.json(idl(n));
});

// ---- MCP server: the whole marketplace as tools for any MCP capable agent ----
setupMcp(app, {
  registry, escrow, governance, connection, escConfig,
  getSkills, getAgents, getStats, prepareExecute, releaseEscrowFlow, buildManifest,
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`AGENTZON api on :${PORT} → ${CLUSTER} (${RPC})`);
  console.log(`registry ${registry.programId.toBase58()}`);
});
