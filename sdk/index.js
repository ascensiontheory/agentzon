// @agentzon/sdk — client for the AGENTZON agent skill marketplace on Solana.
// Wraps the Registry, Escrow, and Governance programs behind a small API.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
const TOKEN = TOKEN_2022_PROGRAM_ID; // $AGENTZON is a Token-2022 mint

const { AnchorProvider, Program, BN, Wallet } = anchor;
const __dirname = dirname(fileURLToPath(import.meta.url));
const loadIdl = (n) => JSON.parse(readFileSync(join(__dirname, "idl", `${n}.json`), "utf8"));

const CLUSTERS = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
  localnet: "http://127.0.0.1:8899",
};

const rand16 = () => {
  const a = new Uint8Array(16);
  (globalThis.crypto || require("crypto").webcrypto).getRandomValues(a);
  return Array.from(a);
};
const enumKey = (e) => (e && typeof e === "object" ? Object.keys(e)[0] : String(e));

export class AgentzonClient {
  /**
   * @param {object} opts
   * @param {Connection} [opts.connection]
   * @param {string}     [opts.rpc]        RPC url (overrides cluster)
   * @param {string}     [opts.cluster]    'devnet' | 'mainnet' | 'localnet'
   * @param {Keypair}    [opts.keypair]    signer (Node)
   * @param {object}     [opts.wallet]     wallet adapter (browser); overrides keypair
   */
  constructor(opts = {}) {
    const cluster = opts.cluster || "mainnet";
    this.cluster = cluster;
    this.connection = opts.connection || new Connection(opts.rpc || CLUSTERS[cluster], "confirmed");
    const wallet = opts.wallet || new Wallet(opts.keypair || Keypair.generate());
    this.wallet = wallet;
    this.provider = new AnchorProvider(this.connection, wallet, { commitment: "confirmed" });

    this.registry = new Program(loadIdl("registry"), this.provider);
    this.escrow = new Program(loadIdl("escrow"), this.provider);
    this.governance = new Program(loadIdl("governance"), this.provider);

    this.agents = new Agents(this);
    this.skills = new Skills(this);
    this.escrowApi = new Escrow(this);
    this.gov = new Governance(this);
  }

  get me() {
    return this.provider.wallet.publicKey;
  }

  // ---- PDA helpers ----
  registryConfigPda() {
    return PublicKey.findProgramAddressSync([Buffer.from("config")], this.registry.programId)[0];
  }
  agentPda(operator = this.me) {
    return PublicKey.findProgramAddressSync([Buffer.from("agent"), operator.toBuffer()], this.registry.programId)[0];
  }
  skillPda(agent, skillId) {
    return PublicKey.findProgramAddressSync([Buffer.from("skill"), agent.toBuffer(), Buffer.from(skillId)], this.registry.programId)[0];
  }
  escrowConfigPda() {
    return PublicKey.findProgramAddressSync([Buffer.from("config")], this.escrow.programId)[0];
  }
  escrowPda(execId) {
    return PublicKey.findProgramAddressSync([Buffer.from("escrow"), Buffer.from(execId)], this.escrow.programId)[0];
  }
  govConfigPda() {
    return PublicKey.findProgramAddressSync([Buffer.from("config")], this.governance.programId)[0];
  }
  stakePda(staker = this.me) {
    return PublicKey.findProgramAddressSync([Buffer.from("stake"), staker.toBuffer()], this.governance.programId)[0];
  }
  proposalPda(id) {
    return PublicKey.findProgramAddressSync([Buffer.from("proposal"), Buffer.from(id)], this.governance.programId)[0];
  }
  voteRecordPda(proposal, voter = this.me) {
    return PublicKey.findProgramAddressSync([Buffer.from("vote"), proposal.toBuffer(), voter.toBuffer()], this.governance.programId)[0];
  }

  // ---- aggregate stats ----
  async stats() {
    const [rc, gc] = await Promise.all([
      this.registry.account.config.fetchNullable(this.registryConfigPda()),
      this.governance.account.govConfig.fetchNullable(this.govConfigPda()),
    ]);
    return {
      agents: rc ? Number(rc.totalAgents) : 0,
      skills: rc ? Number(rc.totalSkills) : 0,
      totalStaked: gc ? gc.totalStaked.toString() : "0",
      proposals: gc ? Number(gc.proposalCount) : 0,
      agentzonMint: rc ? rc.agentzonMint.toBase58() : null,
    };
  }
}

class Agents {
  constructor(c) { this.c = c; }
  async register({ name, metadataUri = "" }) {
    const c = this.c;
    const agent = c.agentPda();
    const sig = await c.registry.methods
      .registerAgent(rand16(), name, metadataUri)
      .accountsStrict({ config: c.registryConfigPda(), agent, operator: c.me, systemProgram: SystemProgram.programId })
      .rpc();
    return { sig, agent: agent.toBase58() };
  }
  async get(operator = this.c.me) {
    return this.c.registry.account.agentAccount.fetchNullable(this.c.agentPda(operator));
  }
  async all() {
    return (await this.c.registry.account.agentAccount.all()).map((r) => ({
      pubkey: r.publicKey.toBase58(),
      operator: r.account.operator.toBase58(),
      name: r.account.name,
      reputation: Number(r.account.reputationScore) / 100,
      executions: Number(r.account.totalExecutions),
      earnings: r.account.totalEarnings.toString(),
      staked: r.account.stakedAmount.toString(),
      status: enumKey(r.account.status),
    }));
  }
}

class Skills {
  constructor(c) { this.c = c; }
  async list({ name, price, category, schemaUri = "" }) {
    const c = this.c;
    const agent = c.agentPda();
    const id = rand16();
    const skill = c.skillPda(agent, id);
    const sig = await c.registry.methods
      .listSkill(id, name, new BN(price), { [category]: {} }, schemaUri)
      .accountsStrict({ config: c.registryConfigPda(), agent, skill, operator: c.me, systemProgram: SystemProgram.programId })
      .rpc();
    return { sig, skill: skill.toBase58() };
  }
  async all() {
    return (await this.c.registry.account.skillAccount.all()).map((r) => ({
      pubkey: r.publicKey.toBase58(),
      sellerAgent: r.account.sellerAgent.toBase58(),
      name: r.account.name,
      price: r.account.price.toString(),
      category: enumKey(r.account.category),
      executions: Number(r.account.executionCount),
      status: enumKey(r.account.status),
    }));
  }
  async get(pubkey) {
    return this.c.registry.account.skillAccount.fetch(new PublicKey(pubkey));
  }
}

class Escrow {
  constructor(c) { this.c = c; }
  /** Buyer funds an escrow for a skill execution. */
  async create({ mint, amount, deadlineSecs = 3600, buyerToken, sellerToken }) {
    const c = this.c;
    const execId = rand16();
    const escrowPda = c.escrowPda(execId);
    const vault = getAssociatedTokenAddressSync(new PublicKey(mint), escrowPda, true, TOKEN);
    const sig = await c.escrow.methods
      .createEscrow(execId, new BN(amount), new BN(deadlineSecs))
      .accountsStrict({
        config: c.escrowConfigPda(), escrow: escrowPda, vault, mint: new PublicKey(mint),
        buyerToken: new PublicKey(buyerToken), sellerToken: new PublicKey(sellerToken), buyer: c.me,
        tokenProgram: TOKEN, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .rpc();
    return { sig, escrow: escrowPda.toBase58(), execId };
  }
  /** Protocol authority releases: 90% seller / 5% treasury / 5% burned. */
  async release({ escrow, mint, vault, sellerToken, treasuryToken }) {
    const c = this.c;
    const sig = await c.escrow.methods
      .releaseEscrow()
      .accountsStrict({
        config: c.escrowConfigPda(), escrow: new PublicKey(escrow), vault: new PublicKey(vault),
        sellerToken: new PublicKey(sellerToken), treasuryToken: new PublicKey(treasuryToken),
        mint: new PublicKey(mint), authority: c.me, tokenProgram: TOKEN,
      })
      .rpc();
    return { sig };
  }
  /** Refund the buyer (after deadline, or by authority on dispute). */
  async refund({ escrow, mint, vault, buyerToken }) {
    const c = this.c;
    const sig = await c.escrow.methods
      .refundEscrow()
      .accountsStrict({
        config: c.escrowConfigPda(), escrow: new PublicKey(escrow), vault: new PublicKey(vault),
        buyerToken: new PublicKey(buyerToken), mint: new PublicKey(mint), caller: c.me, tokenProgram: TOKEN,
      })
      .rpc();
    return { sig };
  }
  vaultFor(escrowPubkey, mint) {
    return getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(escrowPubkey), true, TOKEN);
  }
}

class Governance {
  constructor(c) { this.c = c; }
  async stake(amount, { mint, stakerToken }) {
    const c = this.c;
    const vault = getAssociatedTokenAddressSync(new PublicKey(mint), c.govConfigPda(), true, TOKEN);
    const sig = await c.governance.methods
      .stake(new BN(amount))
      .accountsStrict({
        config: c.govConfigPda(), stakeAccount: c.stakePda(), vault,
        stakerToken: new PublicKey(stakerToken), mint: new PublicKey(mint), staker: c.me,
        tokenProgram: TOKEN, systemProgram: SystemProgram.programId,
      })
      .rpc();
    return { sig };
  }
  async createProposal({ title, descriptionUri = "", votingPeriodSecs }) {
    const c = this.c;
    const id = rand16();
    const proposal = c.proposalPda(id);
    const sig = await c.governance.methods
      .createProposal(id, title, descriptionUri, new BN(votingPeriodSecs))
      .accountsStrict({ config: c.govConfigPda(), stakeAccount: c.stakePda(), proposal, proposer: c.me, systemProgram: SystemProgram.programId })
      .rpc();
    return { sig, proposal: proposal.toBase58(), id };
  }
  async vote(proposalPubkey, inFavor) {
    const c = this.c;
    const proposal = new PublicKey(proposalPubkey);
    const sig = await c.governance.methods
      .vote(inFavor)
      .accountsStrict({ proposal, stakeAccount: c.stakePda(), voteRecord: c.voteRecordPda(proposal), voter: c.me, systemProgram: SystemProgram.programId })
      .rpc();
    return { sig };
  }
  async finalize(proposalPubkey) {
    const c = this.c;
    const sig = await c.governance.methods
      .finalizeProposal()
      .accountsStrict({ proposal: new PublicKey(proposalPubkey), caller: c.me })
      .rpc();
    return { sig };
  }
  async requestUnstake() {
    const c = this.c;
    const sig = await c.governance.methods
      .requestUnstake()
      .accountsStrict({ stakeAccount: c.stakePda(), staker: c.me })
      .rpc();
    return { sig };
  }
  async proposal(pubkey) {
    return this.c.governance.account.proposal.fetch(new PublicKey(pubkey));
  }
}

export default AgentzonClient;
