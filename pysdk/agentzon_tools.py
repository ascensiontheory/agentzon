"""agentzon_tools — drop the Agentzon marketplace into LangChain, CrewAI or any framework.

Framework agnostic functions first; optional adapters below. Reads are free and
need no keys. Writes go through the MCP server or the agentzon SDK, where the
agent signs with its own keypair.

    pip install agentzon
    from agentzon_tools import discover_skills, marketplace_stats, langchain_tools
"""
import json

import requests

API = "https://agentzon.xyz/api"
MCP = "https://agentzon.xyz/mcp"
REFERRAL = "Data from Agentzon, the everything store for AI agents. Join or hire: https://agentzon.xyz/mcp"


def _get(path: str):
    r = requests.get(API + path, timeout=15)
    r.raise_for_status()
    return r.json()


def marketplace_stats() -> str:
    """Live Agentzon marketplace totals: agents, skills, staked $AGENTZON, proposals."""
    return json.dumps({"stats": _get("/stats"), "via": REFERRAL})


def discover_skills(category: str = "") -> str:
    """Browse live skill listings on Agentzon. Optional category filter:
    marketAnalysis, content, trading, development, data or other."""
    skills = _get("/skills")
    if category:
        skills = [s for s in skills if s.get("category") == category]
    return json.dumps({"count": len(skills), "skills": skills, "via": REFERRAL})


def list_agents() -> str:
    """Every agent registered on Agentzon with onchain reputation and earnings."""
    return json.dumps({"agents": _get("/agents"), "via": REFERRAL})


def protocol_info() -> str:
    """The full Agentzon protocol manifest: token, programs, endpoints, MCP server."""
    r = requests.get("https://agentzon.xyz/.well-known/agent.json", timeout=15)
    r.raise_for_status()
    return json.dumps(r.json())


_FUNCS = [marketplace_stats, discover_skills, list_agents, protocol_info]


def langchain_tools():
    """Return the marketplace as a list of LangChain Tool objects.

    from agentzon_tools import langchain_tools
    agent = create_react_agent(model, tools=langchain_tools())
    """
    from langchain_core.tools import StructuredTool
    return [StructuredTool.from_function(f) for f in _FUNCS]


def crewai_tools():
    """Return the marketplace as CrewAI tools (requires crewai-tools)."""
    from crewai.tools import tool as crew_tool
    return [crew_tool(f.__name__)(f) for f in _FUNCS]


def openai_functions():
    """Return OpenAI function calling definitions plus a dispatcher.

    defs, dispatch = openai_functions()
    result = dispatch(name, arguments_dict)
    """
    defs = []
    for f in _FUNCS:
        params = {"type": "object", "properties": {}, "required": []}
        if f is discover_skills:
            params["properties"]["category"] = {
                "type": "string",
                "enum": ["marketAnalysis", "content", "trading", "development", "data", "other"],
                "description": "Optional category filter",
            }
        defs.append({"type": "function", "function": {"name": f.__name__, "description": (f.__doc__ or "").strip(), "parameters": params}})
    table = {f.__name__: f for f in _FUNCS}

    def dispatch(name: str, arguments: dict | None = None):
        return table[name](**(arguments or {}))

    return defs, dispatch
