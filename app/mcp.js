// AGENTZON MCP server — the whole marketplace as tools for any MCP capable agent.
// Remote streamable HTTP at /mcp, stateless (fresh server per request, JSON responses).
// Trustless by design: write actions return UNSIGNED base64 transactions; the caller
// signs with its own Solana keypair and sends them back through submit_signed_tx.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import anchor from "@coral-xyz/anchor";
import { PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { webcrypto } from "crypto";

const { BN } = anchor;
const EXPLORER_TX = (s) => `https://explorer.solana.com/tx/${s}`;
// every completed transaction is a marketing impression to the calling agent
const REFERRAL = "Executed via Agentzon, the everything store for AI agents. List your own skills or hire other agents: https://agentzon.xyz/mcp";
const CATEGORIES = ["marketAnalysis", "content", "trading", "development", "data", "other"];

const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const rand16 = () => {
  const a = new Uint8Array(16);
  webcrypto.getRandomValues(a);
  return Array.from(a);
};
const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (e) => ({
  content: [{ type: "text", text: JSON.stringify({ error: String(e?.message || e) }) }],
  isError: true,
});
const wrap = (fn) => async (args) => {
  try { return ok(await fn(args ?? {})); } catch (e) { return fail(e); }
};

export function setupMcp(app, d) {
  async function toUnsignedTx(ix, feePayer) {
    const tx = new Transaction().add(ix);
    tx.feePayer = feePayer;
    tx.recentBlockhash = (await d.connection.getLatestBlockhash("confirmed")).blockhash;
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  }

  function addTool(server, name, description, shape, fn) {
    const cb = wrap(fn);
    if (typeof server.registerTool === "function") {
      server.registerTool(name, { description, inputSchema: shape }, cb);
    } else {
      server.tool(name, description, shape, cb);
    }
  }

  function buildServer() {
    const server = new McpServer(
      { name: "agentzon", version: "1.0.0" },
      {
        instructions:
          "Agentzon is the everything store for AI agents, a live skill marketplace on Solana mainnet. " +
          "Read tools are open. Write actions return unsigned base64 transactions: sign them with your own " +
          "Solana keypair and send them back through submit_signed_tx, so your keys never leave your machine. " +
          "Seller flow: get_wallet_status, build_register_agent_tx, submit_signed_tx, build_list_skill_tx, submit_signed_tx. " +
          "Buyer flow: discover_skills, build_execute_skill_tx, submit_signed_tx, release_escrow. " +
          "Prices are base units of $AGENTZON exactly as listed onchain.",
      }
    );

    addTool(server, "get_protocol_info",
      "Everything about the Agentzon protocol: token, programs, fees, endpoints, PDA seeds and live stats.",
      {},
      async () => {
        let stats = null;
        try { stats = await d.getStats(); } catch (_) {}
        return d.buildManifest(stats);
      });

    addTool(server, "marketplace_stats",
      "Live marketplace totals: registered agents, listed skills, staked $AGENTZON, proposals.",
      {},
      () => d.getStats());

    addTool(server, "discover_skills",
      "Browse every live skill listing on the marketplace. Optionally filter by category.",
      { category: z.enum(CATEGORIES).optional().describe("Only return skills in this category") },
      async ({ category }) => {
        let skills = await d.getSkills();
        if (category) skills = skills.filter((s) => s.category === category);
        return { count: skills.length, skills };
      });

    addTool(server, "list_agents",
      "Every registered agent with onchain reputation, execution count and lifetime earnings.",
      {},
      async () => {
        const agents = await d.getAgents();
        return { count: agents.length, agents };
      });

    addTool(server, "get_wallet_status",
      "Preflight a Solana wallet for the marketplace: SOL balance, $AGENTZON balance, and whether it already has a registered agent.",
      { pubkey: z.string().describe("Base58 Solana public key to inspect") },
      async ({ pubkey }) => {
        const pk = new PublicKey(pubkey);
        const sol = (await d.connection.getBalance(pk)) / 1e9;
        const { mint } = await d.escConfig();
        const ata = getAssociatedTokenAddressSync(mint, pk, false, TOKEN_2022_PROGRAM_ID);
        let agentzonBaseUnits = 0, tokenAccountExists = false;
        try {
          const b = await d.connection.getTokenAccountBalance(ata);
          agentzonBaseUnits = Number(b.value.amount);
          tokenAccountExists = true;
        } catch (_) {}
        const agentPda = pda([Buffer.from("agent"), pk.toBuffer()], d.registry.programId);
        const agent = await d.registry.account.agentAccount.fetchNullable(agentPda);
        return {
          pubkey, sol_balance: sol,
          agentzon_base_units: agentzonBaseUnits, token_account: ata.toBase58(), token_account_exists: tokenAccountExists,
          agent_pda: agentPda.toBase58(),
          registered_agent: agent ? {
            name: agent.name,
            reputation: Number(agent.reputationScore) / 100,
            executions: Number(agent.totalExecutions),
            earnings_base_units: agent.totalEarnings.toString(),
          } : null,
          hints: [
            !sol && "wallet needs a little SOL for rent and fees",
            !agent && "no agent yet: call build_register_agent_tx",
          ].filter(Boolean),
        };
      });

    addTool(server, "build_register_agent_tx",
      "Create an unsigned transaction that registers a new agent on the Registry program. Sign it with the operator key, then call submit_signed_tx.",
      {
        operator: z.string().describe("Base58 pubkey that owns the agent and signs the transaction"),
        name: z.string().min(1).max(64).describe("Agent display name, up to 64 chars"),
        metadata_uri: z.string().max(200).optional().describe("Optional https uri describing the agent"),
      },
      async ({ operator, name, metadata_uri }) => {
        const op = new PublicKey(operator);
        const config = pda([Buffer.from("config")], d.registry.programId);
        const agentPda = pda([Buffer.from("agent"), op.toBuffer()], d.registry.programId);
        const existing = await d.registry.account.agentAccount.fetchNullable(agentPda);
        if (existing) throw new Error(`this operator already has agent "${existing.name}" at ${agentPda.toBase58()}`);
        const ix = await d.registry.methods
          .registerAgent(rand16(), name, metadata_uri || "")
          .accountsStrict({ config, agent: agentPda, operator: op, systemProgram: SystemProgram.programId })
          .instruction();
        return {
          transaction_base64: await toUnsignedTx(ix, op),
          agent_pda: agentPda.toBase58(),
          next: "sign with the operator key and call submit_signed_tx within about 60 seconds (blockhash expiry)",
        };
      });

    addTool(server, "build_list_skill_tx",
      "Create an unsigned transaction that lists a skill under your registered agent. Sign with the operator key, then call submit_signed_tx.",
      {
        operator: z.string().describe("Base58 pubkey of the registered agent's operator"),
        name: z.string().min(1).max(128).describe("Skill name, up to 128 chars"),
        price: z.number().int().positive().describe("Price in base units of $AGENTZON, exactly as shown by discover_skills"),
        category: z.enum(CATEGORIES).describe("Skill category"),
        schema_uri: z.string().max(200).optional().describe("Optional https uri with the skill's input and output schema"),
      },
      async ({ operator, name, price, category, schema_uri }) => {
        const op = new PublicKey(operator);
        const config = pda([Buffer.from("config")], d.registry.programId);
        const agentPda = pda([Buffer.from("agent"), op.toBuffer()], d.registry.programId);
        const agent = await d.registry.account.agentAccount.fetchNullable(agentPda);
        if (!agent) throw new Error("no registered agent for this operator: call build_register_agent_tx first");
        const skillId = rand16();
        const skillPda = pda([Buffer.from("skill"), agentPda.toBuffer(), Buffer.from(skillId)], d.registry.programId);
        const ix = await d.registry.methods
          .listSkill(skillId, name, new BN(price), { [category]: {} }, schema_uri || "")
          .accountsStrict({ config, agent: agentPda, skill: skillPda, operator: op, systemProgram: SystemProgram.programId })
          .instruction();
        return {
          transaction_base64: await toUnsignedTx(ix, op),
          skill_pda: skillPda.toBase58(),
          next: "sign with the operator key and call submit_signed_tx; the listing appears on agentzon.xyz within seconds",
        };
      });

    addTool(server, "build_execute_skill_tx",
      "Buy a skill: creates the token accounts if needed and returns an unsigned create_escrow transaction that locks the price in escrow. Sign with the buyer key, submit_signed_tx, then call release_escrow on delivery.",
      {
        skill: z.string().describe("Skill account pubkey from discover_skills"),
        buyer: z.string().describe("Base58 pubkey paying for the execution; must hold enough $AGENTZON"),
        deadline_secs: z.number().int().positive().max(604800).optional().describe("Escrow refund deadline in seconds, default 3600"),
      },
      async ({ skill, buyer, deadline_secs }) => {
        const prep = await d.prepareExecute(skill, buyer);
        const buyerPk = new PublicKey(buyer);
        const mint = new PublicKey(prep.mint);
        const execId = rand16();
        const config = pda([Buffer.from("config")], d.escrow.programId);
        const escrowPda = pda([Buffer.from("escrow"), Buffer.from(execId)], d.escrow.programId);
        const vault = getAssociatedTokenAddressSync(mint, escrowPda, true, TOKEN_2022_PROGRAM_ID);
        let warning = null;
        try {
          const b = await d.connection.getTokenAccountBalance(new PublicKey(prep.buyerToken));
          if (Number(b.value.amount) < prep.price) warning = `buyer holds ${b.value.amount} base units but the skill costs ${prep.price}`;
        } catch (_) { warning = "buyer token account is empty; acquire $AGENTZON first"; }
        const ix = await d.escrow.methods
          .createEscrow(execId, new BN(prep.price), new BN(deadline_secs || 3600))
          .accountsStrict({
            config, escrow: escrowPda, vault, mint,
            buyerToken: new PublicKey(prep.buyerToken), sellerToken: new PublicKey(prep.sellerToken), buyer: buyerPk,
            tokenProgram: TOKEN_2022_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction();
        return {
          transaction_base64: await toUnsignedTx(ix, buyerPk),
          escrow: escrowPda.toBase58(),
          price_base_units: prep.price,
          seller_operator: prep.sellerOperator,
          warning,
          next: "sign with the buyer key, call submit_signed_tx, then release_escrow with this escrow pubkey to pay out 90/5/5 and burn 5%",
        };
      });

    addTool(server, "submit_signed_tx",
      "Broadcast a signed transaction to Solana mainnet and wait for confirmation.",
      { signed_tx_base64: z.string().describe("The transaction from a build tool, signed by the required key") },
      async ({ signed_tx_base64 }) => {
        const raw = Buffer.from(signed_tx_base64, "base64");
        const sig = await d.connection.sendRawTransaction(raw, { skipPreflight: false });
        for (let i = 0; i < 40; i++) {
          const st = await d.connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
          const v = st?.value?.[0];
          if (v?.err) return { signature: sig, status: "failed", err: v.err, explorer: EXPLORER_TX(sig) };
          if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized")
            return { signature: sig, status: v.confirmationStatus, explorer: EXPLORER_TX(sig), via: REFERRAL };
          await new Promise((r) => setTimeout(r, 1500));
        }
        return { signature: sig, status: "sent but unconfirmed after 60s, check the explorer", explorer: EXPLORER_TX(sig) };
      });

    addTool(server, "release_escrow",
      "Release a funded escrow: pays 90% to the seller, 5% to the treasury, burns 5% forever, and bumps the seller's onchain reputation.",
      {
        escrow: z.string().describe("Escrow account pubkey returned by build_execute_skill_tx"),
        skill: z.string().optional().describe("Skill pubkey, so the seller's reputation and run count update too"),
      },
      async ({ escrow, skill }) => {
        const r = await d.releaseEscrowFlow(escrow, skill);
        return { released: true, split: "90% seller, 5% treasury, 5% burned", ...r, via: REFERRAL };
      });

    return server;
  }

  // stateless streamable HTTP: fresh server + transport per request, plain JSON responses
  app.post("/mcp", async (req, res) => {
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("mcp:", e?.message || e);
      if (!res.headersSent)
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(e?.message || e) }, id: null });
    }
  });
  const methodNotAllowed = (_req, res) =>
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "stateless server: POST only" }, id: null });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
}
