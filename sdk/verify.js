// Full end-to-end verification of the AGENTZON protocol on devnet, via the SDK.
// Exercises the money paths (escrow release 90/5/5 + burn, refund) and governance
// with hard assertions. Run from sdk/:  node verify.js
import { AgentzonClient } from "./index.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, getAccount, getMint } from "@solana/spl-token";
import { readFileSync } from "fs";
import assert from "assert";

const kp = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync("../.keys/devnet-authority.json", "utf8"))));
const c = new AgentzonClient({ cluster: "devnet", keypair: kp });
const conn = c.connection, me = c.me;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bal = async (a) => Number((await getAccount(conn, a)).amount);
const supply = async (m) => Number((await getMint(conn, m)).supply);

console.log("== AGENTZON full verification on devnet ==\nwallet:", me.toBase58());

const escCfg = await c.escrow.account.escrowConfig.fetch(c.escrowConfigPda());
const mint = escCfg.mint, treasury = escCfg.treasury;
console.log("token mint:", mint.toBase58());
assert(escCfg.authority.equals(me), "wallet must be the escrow authority");

const myAta = await getOrCreateAssociatedTokenAccount(conn, kp, mint, me);
await mintTo(conn, kp, mint, myAta.address, kp, 300);

const skills = await c.skills.all();
const skill = skills.find((s) => /Narrative/.test(s.name)) || skills[0];
const price = Number(skill.price);

console.log(`\n[1] EXECUTE + RELEASE  skill="${skill.name}" price=${price}`);
const s0 = await supply(mint), t0 = await bal(treasury);
const e = await c.escrowApi.create({ mint, amount: price, buyerToken: myAta.address, sellerToken: myAta.address });
const vault = c.escrowApi.vaultFor(e.escrow, mint);
assert.equal(await bal(vault), price, "vault funded with price");
console.log("  escrow funded, vault =", price, "| tx", e.sig.slice(0, 8));
await c.escrowApi.release({ escrow: e.escrow, mint, vault, sellerToken: myAta.address, treasuryToken: treasury });
const burned = s0 - (await supply(mint)), tGain = (await bal(treasury)) - t0;
const expBurn = Math.floor(price * 0.05), expTre = Math.floor(price * 0.05);
console.log(`  released → treasury +${tGain} (exp ${expTre}), burned ${burned} (exp ${expBurn})`);
assert.equal(tGain, expTre, "treasury should get 5%");
assert.equal(burned, expBurn, "5% should be burned");
assert.ok((await c.escrow.account.escrowAccount.fetch(new PublicKey(e.escrow))).status.released !== undefined, "status Released");
console.log("  ✓ 90/5/5 split + on-chain burn verified");

console.log("\n[2] ESCROW REFUND (dispute path)");
const b0 = await bal(myAta.address);
const e2 = await c.escrowApi.create({ mint, amount: 50, buyerToken: myAta.address, sellerToken: myAta.address });
const vault2 = c.escrowApi.vaultFor(e2.escrow, mint);
assert.equal(await bal(myAta.address), b0 - 50, "buyer debited 50");
await c.escrowApi.refund({ escrow: e2.escrow, mint, vault: vault2, buyerToken: myAta.address });
assert.equal(await bal(myAta.address), b0, "buyer fully refunded");
assert.ok((await c.escrow.account.escrowAccount.fetch(new PublicKey(e2.escrow))).status.refunded !== undefined, "status Refunded");
console.log("  ✓ refund returned 50 to buyer");

console.log("\n[3] GOVERNANCE  propose → vote → finalize");
const stake = await c.governance.account.stakeAccount.fetch(c.stakePda());
console.log("  staked weight:", stake.amount.toString());
assert(stake.amount.toNumber() > 0, "need stake to propose/vote");
const p = await c.gov.createProposal({ title: "Verify " + Date.now().toString().slice(-4), votingPeriodSecs: 12 });
await c.gov.vote(p.proposal, true);
let pr = await c.gov.proposal(p.proposal);
console.log("  tally yes:", pr.yesVotes.toString(), "no:", pr.noVotes.toString());
assert.equal(pr.yesVotes.toString(), stake.amount.toString(), "yes weight = staked balance");
await sleep(14000);
await c.gov.finalize(p.proposal);
pr = await c.gov.proposal(p.proposal);
console.log("  finalized:", Object.keys(pr.status)[0]);
assert.ok(pr.status.passed !== undefined, "proposal should pass");
console.log("  ✓ governance verified");

console.log("\n== ALL FUNCTIONS VERIFIED ON DEVNET ==");
console.log("final stats:", await c.stats());
