import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";
import governanceIdl from "../target/idl/governance.json";

const rand16 = () => Array.from(Keypair.generate().publicKey.toBuffer().slice(0, 16));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("AGENTZON Governance — devnet functional test", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wallet = provider.wallet as anchor.Wallet;
  const conn = provider.connection;
  const gov = new Program(governanceIdl as anchor.Idl, provider);

  it("stake → propose → vote → finalize (passes), and unstake-before-cooldown fails", async () => {
    console.log("governance:", gov.programId.toBase58());

    // gov uses its own singleton config, so a fresh mint each run needs a fresh config —
    // config is a PDA at ["config"], created once. Reuse if already initialized.
    const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], gov.programId);
    let cfg: any = await gov.account.govConfig.fetchNullable(config);

    // On first run, initialize with a fresh mint. On later runs, reuse the stored mint.
    let mint: PublicKey;
    if (!cfg) {
      mint = await createMint(conn, wallet.payer, wallet.publicKey, null, 0);
      const vault = getAssociatedTokenAddressSync(mint, config, true);
      await gov.methods
        .initialize()
        .accountsStrict({
          config,
          mint,
          vault,
          authority: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      cfg = await gov.account.govConfig.fetch(config);
      console.log("gov initialized with mint", mint.toBase58());
    } else {
      mint = cfg.mint as PublicKey;
      console.log("gov already initialized, mint", mint.toBase58());
    }

    const vault = getAssociatedTokenAddressSync(mint, config, true);
    const stakerAta = await getOrCreateAssociatedTokenAccount(conn, wallet.payer, mint, wallet.publicKey);
    // fund the staker so we can stake 100
    await mintTo(conn, wallet.payer, mint, stakerAta.address, wallet.publicKey, 100);

    const [stakeAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("stake"), wallet.publicKey.toBuffer()],
      gov.programId
    );

    // --- stake 100 ---
    await gov.methods
      .stake(new anchor.BN(100))
      .accountsStrict({
        config,
        stakeAccount,
        vault,
        stakerToken: stakerAta.address,
        mint,
        staker: wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    let sa: any = await gov.account.stakeAccount.fetch(stakeAccount);
    console.log("staked:", sa.amount.toNumber());
    assert.ok(sa.amount.toNumber() >= 100);

    // --- negative: request_unstake then unstake should fail (7-day cooldown) ---
    await gov.methods
      .requestUnstake()
      .accountsStrict({ stakeAccount, staker: wallet.publicKey })
      .rpc();
    let cooldownEnforced = false;
    try {
      await gov.methods
        .unstake()
        .accountsStrict({
          config,
          stakeAccount,
          vault,
          stakerToken: stakerAta.address,
          mint,
          staker: wallet.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    } catch (e: any) {
      cooldownEnforced = String(e).includes("CooldownNotElapsed") || String(e).includes("cooldown");
    }
    assert.ok(cooldownEnforced, "unstake before cooldown must fail");
    console.log("unstake-before-cooldown correctly rejected");

    // --- create proposal (12s voting window) ---
    const pid = rand16();
    const [proposal] = PublicKey.findProgramAddressSync([Buffer.from("proposal"), Buffer.from(pid)], gov.programId);
    await gov.methods
      .createProposal(pid, "Raise listing fee to 2%", "ipfs://proposal-1", new anchor.BN(12))
      .accountsStrict({ config, stakeAccount, proposal, proposer: wallet.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    console.log("proposal created:", proposal.toBase58());

    // --- vote YES (weight = staked balance) ---
    const [voteRecord] = PublicKey.findProgramAddressSync(
      [Buffer.from("vote"), proposal.toBuffer(), wallet.publicKey.toBuffer()],
      gov.programId
    );
    await gov.methods
      .vote(true)
      .accountsStrict({ proposal, stakeAccount, voteRecord, voter: wallet.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    let prop: any = await gov.account.proposal.fetch(proposal);
    console.log("tally → yes:", prop.yesVotes.toNumber(), "no:", prop.noVotes.toNumber());
    assert.equal(prop.yesVotes.toNumber(), sa.amount.toNumber());

    // --- double vote must fail (VoteRecord PDA already exists) ---
    let doubleBlocked = false;
    try {
      await gov.methods
        .vote(true)
        .accountsStrict({ proposal, stakeAccount, voteRecord, voter: wallet.publicKey, systemProgram: SystemProgram.programId })
        .rpc();
    } catch (_) {
      doubleBlocked = true;
    }
    assert.ok(doubleBlocked, "double vote must fail");
    console.log("double-vote correctly rejected");

    // --- wait out the voting window, then finalize ---
    await sleep(14000);
    await gov.methods
      .finalizeProposal()
      .accountsStrict({ proposal, caller: wallet.publicKey })
      .rpc();
    prop = await gov.account.proposal.fetch(proposal);
    console.log("finalized status:", Object.keys(prop.status)[0]);
    assert.ok(prop.status.passed !== undefined, "proposal should pass (yes>no, quorum met)");
    console.log("governance cycle verified on devnet");
  });
});
