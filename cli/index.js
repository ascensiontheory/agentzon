#!/usr/bin/env node
// AGENTZON CLI — thin command-line wrapper over @agentzon/sdk.
import { Command } from "commander";
import { AgentzonClient } from "@agentzon/sdk";
import { Keypair } from "@solana/web3.js";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const program = new Command();
program
  .name("agentzon")
  .description("AGENTZON — agent skill marketplace on Solana")
  .version("0.1.0")
  .option("-k, --keypair <path>", "wallet keypair file", join(homedir(), ".config", "solana", "id.json"))
  .option("-c, --cluster <cluster>", "mainnet | devnet | localnet", "mainnet")
  .option("--api <url>", "backend API base URL", "https://agentzon.xyz/api");

function client(readOnly = false) {
  const o = program.opts();
  let keypair;
  if (!readOnly) {
    if (!existsSync(o.keypair)) {
      console.error("keypair not found:", o.keypair, "\nPass one with --keypair <path>.");
      process.exit(1);
    }
    keypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(o.keypair, "utf8"))));
  }
  return new AgentzonClient({ cluster: o.cluster, keypair });
}
const api = () => program.opts().api;
const post = (p, b) => fetch(api() + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());

program.command("stats").description("network stats").action(async () => {
  console.log(await client(true).stats());
});

program.command("skills").description("list on-chain skills").action(async () => {
  const rows = await client(true).skills.all();
  if (!rows.length) return console.log("(no skills listed yet)");
  rows.forEach((s) => console.log(`${s.pubkey}  ${s.name.padEnd(24)} ${String(s.price).padStart(6)} $AGENTZON  [${s.category}]  ${s.executions} runs`));
});

program.command("agents").description("list registered agents").action(async () => {
  const rows = await client(true).agents.all();
  if (!rows.length) return console.log("(no agents yet)");
  rows.forEach((a) => console.log(`${a.pubkey}  ${a.name.padEnd(20)} rep ${a.reputation}  ${a.executions} execs  ${a.earnings} earned`));
});

program.command("register <name>").description("register your agent").action(async (name) => {
  const r = await client().agents.register({ name });
  console.log("agent registered:", r.agent, "\ntx:", r.sig);
});

program.command("list-skill <name> <price> <category>")
  .description("list a skill (category: marketAnalysis|content|trading|development|data|other)")
  .action(async (name, price, category) => {
    const r = await client().skills.list({ name, price: parseInt(price, 10), category });
    console.log("skill listed:", r.skill, "\ntx:", r.sig);
  });

program.command("execute <skillPubkey>").description("buy/execute a skill").action(async (skill) => {
  const c = client();
  const prep = await post("/prepare-execute", { skill, buyer: c.me.toBase58() });
  if (!prep.ok) throw new Error(prep.error || "prepare failed");
  const e = await c.escrowApi.create({ mint: prep.mint, amount: prep.price, buyerToken: prep.buyerToken, sellerToken: prep.sellerToken });
  const rel = await post("/release", { escrow: e.escrow, skill });
  if (!rel.ok) throw new Error(rel.error || "release failed");
  console.log(`executed "${skill}" — paid ${prep.price} $AGENTZON (90% seller / 5% treasury / 5% burned)\nrelease tx:`, rel.sig);
});

program.command("stake <amount>").description("stake $AGENTZON for governance (needs --mint & --staker-token via env for now)")
  .option("--mint <mint>", "governance token mint")
  .option("--staker-token <ata>", "your token account")
  .action(async (amount, opts) => {
    if (!opts.mint || !opts.stakerToken) return console.error("stake needs --mint and --staker-token");
    const r = await client().gov.stake(parseInt(amount, 10), { mint: opts.mint, stakerToken: opts.stakerToken });
    console.log("staked:", r.sig);
  });

program.parseAsync().catch((e) => { console.error("error:", e?.message || e); process.exit(1); });
