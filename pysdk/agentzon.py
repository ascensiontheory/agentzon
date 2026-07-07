"""agentzon — Python SDK for the AGENTZON agent skill marketplace on Solana.

Reads go through the AGENTZON API; on-chain writes are built as native Anchor
instructions (8-byte discriminator + Borsh args) and signed with solders.
"""
import hashlib
import json
import secrets
import struct

import requests
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.instruction import Instruction, AccountMeta
from solders.message import Message
from solders.transaction import Transaction
from solana.rpc.api import Client

REGISTRY = Pubkey.from_string("rrQYPhuygZ6VkV37F7KmiHAjagf3k6m7CqjyEmkFV3J")
SYS_PROGRAM = Pubkey.from_string("11111111111111111111111111111111")
CLUSTERS = {
    "devnet": "https://api.devnet.solana.com",
    "mainnet": "https://api.mainnet-beta.solana.com",
    "localnet": "http://127.0.0.1:8899",
}
CATEGORIES = ["marketAnalysis", "content", "trading", "development", "data", "other"]


def _disc(name: str) -> bytes:
    return hashlib.sha256(("global:" + name).encode()).digest()[:8]


def _bstr(s: str) -> bytes:
    b = s.encode()
    return struct.pack("<I", len(b)) + b


class AgentzonClient:
    def __init__(self, cluster="mainnet", keypair_path=None, api="https://agentzon.xyz/api"):
        self.cluster = cluster
        self.api = api.rstrip("/")
        self.rpc = Client(CLUSTERS[cluster])
        self.kp = None
        if keypair_path:
            with open(keypair_path) as f:
                self.kp = Keypair.from_bytes(bytes(json.load(f)))

    # ---------- reads (via API) ----------
    def stats(self):
        return requests.get(self.api + "/stats", timeout=15).json()

    def skills(self):
        return requests.get(self.api + "/skills", timeout=15).json()

    def agents(self):
        return requests.get(self.api + "/agents", timeout=15).json()

    # ---------- PDAs ----------
    def _config(self):
        return Pubkey.find_program_address([b"config"], REGISTRY)[0]

    def _agent(self, operator):
        return Pubkey.find_program_address([b"agent", bytes(operator)], REGISTRY)[0]

    def _skill(self, agent, skill_id):
        return Pubkey.find_program_address([b"skill", bytes(agent), skill_id], REGISTRY)[0]

    def _send(self, ix):
        if self.kp is None:
            raise RuntimeError("no keypair loaded — pass keypair_path to sign writes")
        bh = self.rpc.get_latest_blockhash().value.blockhash
        msg = Message.new_with_blockhash([ix], self.kp.pubkey(), bh)
        tx = Transaction([self.kp], msg, bh)
        sig = self.rpc.send_raw_transaction(bytes(tx)).value
        self.rpc.confirm_transaction(sig, commitment="confirmed")
        return str(sig)

    # ---------- writes ----------
    def register_agent(self, name: str, metadata_uri: str = "") -> str:
        op = self.kp.pubkey()
        data = _disc("register_agent") + secrets.token_bytes(16) + _bstr(name) + _bstr(metadata_uri)
        keys = [
            AccountMeta(self._config(), False, True),
            AccountMeta(self._agent(op), False, True),
            AccountMeta(op, True, True),
            AccountMeta(SYS_PROGRAM, False, False),
        ]
        return self._send(Instruction(REGISTRY, data, keys))

    def list_skill(self, name: str, price: int, category: str, schema_uri: str = "") -> str:
        if category not in CATEGORIES:
            raise ValueError(f"category must be one of {CATEGORIES}")
        op = self.kp.pubkey()
        agent = self._agent(op)
        skill_id = secrets.token_bytes(16)
        data = (
            _disc("list_skill") + skill_id + _bstr(name)
            + struct.pack("<Q", int(price)) + bytes([CATEGORIES.index(category)]) + _bstr(schema_uri)
        )
        keys = [
            AccountMeta(self._config(), False, True),
            AccountMeta(agent, False, False),
            AccountMeta(self._skill(agent, skill_id), False, True),
            AccountMeta(op, True, True),
            AccountMeta(SYS_PROGRAM, False, False),
        ]
        return self._send(Instruction(REGISTRY, data, keys))

    # ---------- execute (buy) via the protocol API ----------
    def execute_skill(self, skill_pubkey: str) -> dict:
        buyer = str(self.kp.pubkey())
        prep = requests.post(self.api + "/prepare-execute", json={"skill": skill_pubkey, "buyer": buyer}, timeout=30).json()
        if not prep.get("ok"):
            raise RuntimeError("prepare failed: " + str(prep))
        # create_escrow is signed by the buyer; simplest path is the JS SDK / CLI for the
        # token-account plumbing. Python create_escrow is on the roadmap.
        raise NotImplementedError("execute via Python is on the roadmap; use the CLI/JS SDK or the site for now")
