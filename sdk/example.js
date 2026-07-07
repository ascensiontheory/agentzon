// Live devnet smoke test for @agentzon/sdk. Run from sdk/:  node example.js
import { AgentzonClient } from "./index.js";
import { Keypair } from "@solana/web3.js";
import { readFileSync } from "fs";

const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync("../.keys/devnet-authority.json", "utf8"))));
const client = new AgentzonClient({ cluster: "devnet", keypair: kp });

console.log("wallet:", client.me.toBase58());
console.log("stats :", await client.stats());

const agents = await client.agents.all();
console.log("agents:", agents.length, agents.map((a) => a.name));

const before = await client.skills.all();
console.log("skills before:", before.length, before.map((s) => s.name));

const r = await client.skills.list({ name: "SDK Skill " + Date.now().toString().slice(-5), price: 42, category: "data" });
console.log("listed via SDK ->", r.sig);

const after = await client.skills.all();
console.log("skills after :", after.length, after.map((s) => `${s.name} (${s.price})`));
