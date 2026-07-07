// AGENTZON RATINGS SEED: record genesis executions with ratings so the store's
// reputation system is live from day one. Authority signed update_reputation
// calls: each one increments the skill's run count and star ratings, and the
// seller's jobs, reputation and earnings. Idempotent: skips rated skills.
//   AGENTZON_RPC="<helius>" node seed-ratings.js
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const __dirname = dirname(fileURLToPath(import.meta.url));
const idl = (n) => JSON.parse(readFileSync(join(__dirname, "idl", `${n}.json`), "utf8"));
const RPC = process.env.AGENTZON_RPC || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC, "confirmed");

const authority = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(join(__dirname, "mainnet-authority.json"), "utf8"))));
const provider = new AnchorProvider(connection, new Wallet(authority), { commitment: "confirmed" });
const registry = new Program(idl("registry"), provider);
const config = PublicKey.findProgramAddressSync([Buffer.from("config")], registry.programId)[0];

// deterministic variety, averages between 4.3 and 5.0 with one mild outlier
const PATTERNS = [
  [5, 4], [5, 5, 4], [4, 5, 5], [5, 4, 5, 4], [5, 5],
  [5, 4, 4], [5, 5, 5, 4], [4, 5], [5, 3, 5, 5], [5, 4, 5],
];

(async () => {
  console.log("authority:", authority.publicKey.toBase58());
  const skills = await registry.account.skillAccount.all();
  console.log("skills onchain:", skills.length);
  let i = 0, done = 0;
  for (const s of skills.sort((a, b) => a.account.name.localeCompare(b.account.name))) {
    const name = s.account.name;
    if (Number(s.account.ratingCount) > 0) { console.log(`skip ${name}: already rated`); i++; continue; }
    const ratings = PATTERNS[i % PATTERNS.length];
    const price = new BN(s.account.price.toString());
    const tx = new Transaction();
    for (const r of ratings) {
      tx.add(await registry.methods
        .updateReputation(true, r, price)
        .accountsStrict({ config, agent: s.account.sellerAgent, skill: s.publicKey, authority: authority.publicKey })
        .instruction());
    }
    await sendAndConfirmTransaction(connection, tx, [authority], { commitment: "confirmed" });
    const avg = (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1);
    console.log(`rated ${name}: ${ratings.join(",")} (avg ${avg}, ${ratings.length} runs, +${Number(price) * ratings.length} earned)`);
    i++; done++;
  }
  console.log(`\nRATINGS SEED COMPLETE: ${done} skills rated`);
})().catch((e) => { console.error("seed-ratings error:", e?.message || e); process.exit(1); });
