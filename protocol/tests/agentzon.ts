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
  getMint,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";
import registryIdl from "../target/idl/registry.json";
import escrowIdl from "../target/idl/escrow.json";

const rand16 = () => Array.from(Keypair.generate().publicKey.toBuffer().slice(0, 16));

describe("AGENTZON — devnet functional test", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const wallet = provider.wallet as anchor.Wallet;
  const conn = provider.connection;

  const registry = new Program(registryIdl as anchor.Idl, provider);
  const escrow = new Program(escrowIdl as anchor.Idl, provider);

  it("registers an agent, lists a skill, and runs escrow fund→release with a real burn", async () => {
    console.log("registry:", registry.programId.toBase58());
    console.log("escrow:  ", escrow.programId.toBase58());

    // --- test $AGENTZON-like mint (0 decimals for clean 90/5/5 math) ---
    const mint = await createMint(conn, wallet.payer, wallet.publicKey, null, 0);
    const sellerOwner = Keypair.generate();
    const treasuryOwner = Keypair.generate();
    const buyerAta = await getOrCreateAssociatedTokenAccount(conn, wallet.payer, mint, wallet.publicKey);
    const sellerAta = await getOrCreateAssociatedTokenAccount(conn, wallet.payer, mint, sellerOwner.publicKey);
    const treasuryAta = await getOrCreateAssociatedTokenAccount(conn, wallet.payer, mint, treasuryOwner.publicKey);
    await mintTo(conn, wallet.payer, mint, buyerAta.address, wallet.publicKey, 1000);
    console.log("mint:", mint.toBase58());

    // --- registry: initialize config ---
    const [regConfig] = PublicKey.findProgramAddressSync([Buffer.from("config")], registry.programId);
    await registry.methods
      .initialize(treasuryAta.address, mint)
      .accountsStrict({ config: regConfig, authority: wallet.publicKey, systemProgram: SystemProgram.programId })
      .rpc();

    // --- registry: register_agent ---
    const agentId = rand16();
    const [agentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), wallet.publicKey.toBuffer()],
      registry.programId
    );
    await registry.methods
      .registerAgent(agentId, "TrenchScanner", "ipfs://agent-meta")
      .accountsStrict({ config: regConfig, agent: agentPda, operator: wallet.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    const agentAcct: any = await registry.account.agentAccount.fetch(agentPda);
    assert.equal(agentAcct.name, "TrenchScanner");
    assert.equal(agentAcct.operator.toBase58(), wallet.publicKey.toBase58());
    console.log("agent registered:", agentPda.toBase58());

    // --- registry: list_skill ---
    const skillId = rand16();
    const [skillPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("skill"), agentPda.toBuffer(), Buffer.from(skillId)],
      registry.programId
    );
    await registry.methods
      .listSkill(skillId, "Narrative Scanner", new anchor.BN(100), { marketAnalysis: {} }, "ipfs://skill-schema")
      .accountsStrict({ config: regConfig, agent: agentPda, skill: skillPda, operator: wallet.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    const skillAcct: any = await registry.account.skillAccount.fetch(skillPda);
    assert.equal(skillAcct.price.toNumber(), 100);
    console.log("skill listed:", skillPda.toBase58(), "price", skillAcct.price.toNumber());

    // --- escrow: initialize config ---
    const [escConfig] = PublicKey.findProgramAddressSync([Buffer.from("config")], escrow.programId);
    await escrow.methods
      .initialize(treasuryAta.address)
      .accountsStrict({ config: escConfig, mint, authority: wallet.publicKey, systemProgram: SystemProgram.programId })
      .rpc();

    // --- escrow: create_escrow (buyer funds 100) ---
    const execId = rand16();
    const [escrowPda] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), Buffer.from(execId)], escrow.programId);
    const vault = getAssociatedTokenAddressSync(mint, escrowPda, true);
    await escrow.methods
      .createEscrow(execId, new anchor.BN(100), new anchor.BN(3600))
      .accountsStrict({
        config: escConfig,
        escrow: escrowPda,
        vault,
        mint,
        buyerToken: buyerAta.address,
        sellerToken: sellerAta.address,
        buyer: wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    assert.equal(Number((await getAccount(conn, vault)).amount), 100);
    const supplyBefore = (await getMint(conn, mint)).supply;
    console.log("escrow funded, vault=100, supply before release:", supplyBefore.toString());

    // --- escrow: release_escrow → 90 seller / 5 treasury / burn 5 ---
    await escrow.methods
      .releaseEscrow()
      .accountsStrict({
        config: escConfig,
        escrow: escrowPda,
        vault,
        sellerToken: sellerAta.address,
        treasuryToken: treasuryAta.address,
        mint,
        authority: wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const sellerBal = Number((await getAccount(conn, sellerAta.address)).amount);
    const treasuryBal = Number((await getAccount(conn, treasuryAta.address)).amount);
    const supplyAfter = (await getMint(conn, mint)).supply;
    const burned = Number(supplyBefore - supplyAfter);
    console.log(`released → seller=${sellerBal}  treasury=${treasuryBal}  burned=${burned}`);
    assert.equal(sellerBal, 90, "seller should get 90%");
    assert.equal(treasuryBal, 5, "treasury should get 5%");
    assert.equal(burned, 5, "5% should be burned (supply reduced)");
    const escAcct: any = await escrow.account.escrowAccount.fetch(escrowPda);
    assert.ok(escAcct.status.released !== undefined, "escrow status should be Released");
    console.log("full escrow cycle verified on devnet");
  });
});
