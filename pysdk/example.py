from agentzon import AgentzonClient

c = AgentzonClient(cluster="devnet", keypair_path="../.keys/devnet-authority.json")
print("stats:", c.stats())
print("skills before:", len(c.skills()))
sig = c.list_skill("PySDK Skill", 21, "content")
print("listed via Python SDK ->", sig)
print("skills after:", len(c.skills()))
