# AGENTZON — Devnet Deployment

Deployed 2026-07-01 to Solana **devnet** via the Grindscape-droplet Docker build (Anchor 0.31.1).
Upgrade authority: `FDfyWDzzTzFRZnwnRfrvWX9CC3QqUs7tEW1xvQRfAw9z` (key at `.keys/devnet-authority.json`, gitignored).
All three programs deployed and functionally tested on devnet (tests/agentzon.ts, tests/governance.ts).

| Program | ID | Explorer |
|---|---|---|
| Registry | `rrQYPhuygZ6VkV37F7KmiHAjagf3k6m7CqjyEmkFV3J` | https://explorer.solana.com/address/rrQYPhuygZ6VkV37F7KmiHAjagf3k6m7CqjyEmkFV3J?cluster=devnet |
| Escrow | `5JezjTbDGkHQSja2BoGm6SJQJb7LRSoq6NhtFUoaHZWn` | https://explorer.solana.com/address/5JezjTbDGkHQSja2BoGm6SJQJb7LRSoq6NhtFUoaHZWn?cluster=devnet |
| Governance | `9DmCY5fqZeBYSPd8Z6NLdUAbePUbe4YXCr2HFoUMs2yF` | https://explorer.solana.com/address/9DmCY5fqZeBYSPd8Z6NLdUAbePUbe4YXCr2HFoUMs2yF?cluster=devnet |

Redeploy/upgrade: `anchor deploy -p <name> --provider.cluster devnet --provider.wallet .keys/devnet-authority.json`
Run tests: `ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=<wallet> yarn ts-mocha -p ./tsconfig.json -t 1000000 tests/<file>.ts`
