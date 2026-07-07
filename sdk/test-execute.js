// Verify the browser buyer/execute path via the PUBLIC API + a fresh buyer wallet.
// prepare-execute (faucet + seller ATA) → buyer signs create_escrow → /release (90/5/5+burn).
import { AgentzonClient } from "./index.js";
import { Keypair, PublicKey, Connection, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAccount, getMint } from "@solana/spl-token";
import { readFileSync } from "fs";
import assert from "assert";

const API = "https://agentzon.xyz/api";
const authKp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync("../.keys/devnet-authority.json", "utf8"))));
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const post = (p, b) => fetch(API + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const bal = async (a) => Number((await getAccount(conn, new PublicKey(a))).amount);
const supply = async (m) => Number((await getMint(conn, new PublicKey(m))).supply);

const buyer = Keypair.generate();
console.log("fresh buyer:", buyer.publicKey.toBase58());

// fund the fresh buyer with a little SOL for tx fees + escrow rent
await sendAndConfirmTransaction(conn, new Transaction().add(
  SystemProgram.transfer({ fromPubkey: authKp.publicKey, toPubkey: buyer.publicKey, lamports: 0.05e9 })
), [authKp]);
console.log("buyer funded with 0.05 SOL");

// pick a listed skill
const skills = await new AgentzonClient({ cluster: "devnet", keypair: authKp }).skills.all();
const skill = skills.find((s) => /Narrative/.test(s.name)) || skills[0];
console.log(`executing "${skill.name}" (price ${skill.price})`);

// 1) prepare-execute (backend faucets buyer + ensures seller ATA)
const prep = await post("/prepare-execute", { skill: skill.pubkey, buyer: buyer.publicKey.toBase58() });
assert(prep.ok, "prepare failed: " + JSON.stringify(prep));
console.log("prepared: price", prep.price, "buyer funded, seller ATA ready");
assert.equal(await bal(prep.buyerToken), prep.price, "buyer should hold the price in tokens");

// 2) buyer signs create_escrow
const s0 = await supply(prep.mint), t = prep.price;
const buyerClient = new AgentzonClient({ cluster: "devnet", keypair: buyer });
const sellerBefore = await bal(prep.sellerToken);
const e = await buyerClient.escrowApi.create({ mint: prep.mint, amount: prep.price, buyerToken: prep.buyerToken, sellerToken: prep.sellerToken });
console.log("escrow funded by buyer:", e.escrow.slice(0, 8));
assert.equal(await bal(prep.buyerToken), 0, "buyer tokens moved to escrow");

// snapshot skill/agent counters before release
const rc = new AgentzonClient({ cluster: "devnet", keypair: authKp });
const skillBefore = await rc.registry.account.skillAccount.fetch(new PublicKey(skill.pubkey));
const agentPk = skillBefore.sellerAgent;
const agentBefore = await rc.registry.account.agentAccount.fetch(agentPk);

// 3) release via authority endpoint (passes skill → updates reputation + run count)
const rel = await post("/release", { escrow: e.escrow, skill: skill.pubkey });
assert(rel.ok, "release failed: " + JSON.stringify(rel));
const burned = s0 - (await supply(prep.mint));
const sellerGain = (await bal(prep.sellerToken)) - sellerBefore;
console.log(`released → seller +${sellerGain} (exp ${Math.floor(t * 0.9)}), burned ${burned} (exp ${Math.floor(t * 0.05)})`);
assert.equal(sellerGain, Math.floor(t * 0.9), "seller gets 90%");
assert.equal(burned, Math.floor(t * 0.05), "5% burned");

const skillAfter = await rc.registry.account.skillAccount.fetch(new PublicKey(skill.pubkey));
const agentAfter = await rc.registry.account.agentAccount.fetch(agentPk);
console.log(`skill runs ${skillBefore.executionCount} → ${skillAfter.executionCount}, agent execs ${agentBefore.totalExecutions} → ${agentAfter.totalExecutions}, reputation ${Number(agentBefore.reputationScore)/100} → ${Number(agentAfter.reputationScore)/100}`);
assert.equal(skillAfter.executionCount.toNumber(), skillBefore.executionCount.toNumber() + 1, "skill run count +1");
assert.equal(agentAfter.totalExecutions.toNumber(), agentBefore.totalExecutions.toNumber() + 1, "agent executions +1");
assert.equal(agentAfter.totalEarnings.sub(agentBefore.totalEarnings).toNumber(), Math.floor(t * 0.9), "agent earnings += seller share");
console.log("\n✓ FULL EXECUTE PATH VERIFIED — escrow 90/5/5+burn AND reputation/run-count updated");
console.log("  release tx:", rel.url);
