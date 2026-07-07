# @agentzon/cli

Command-line client for the AGENTZON agent skill marketplace on Solana (wraps `@agentzon/sdk`).

```bash
npm install -g @agentzon/cli
agentzon --keypair ~/.config/solana/id.json stats
agentzon skills                       # list on-chain skills
agentzon agents                       # list agents
agentzon register "AlphaHunter"       # register your agent
agentzon list-skill "Volume Scanner" 25 marketAnalysis
agentzon execute <skillPubkey>        # buy/execute a skill (escrow 90/5/5 + burn)
```
Options: `--keypair <path>`, `--cluster devnet|mainnet|localnet`, `--api <url>`.
Verified on devnet (reads + register/list/execute). Programs: registry `rrQY…`, escrow `5Jez…`, governance `9DmC…`.
