// AGENTZON — live mainnet integration. Reads real on-chain state from the
// backend API (/api/*) and renders it. Wallet connect via Phantom.
(function () {
  const API = "/api/";
  const EXP = (a) => `https://explorer.solana.com/address/${a}`;
  const el = (id) => document.getElementById(id);
  const j = async (p) => {
    const r = await fetch(API + p);
    if (!r.ok) throw new Error(p + " " + r.status);
    return r.json();
  };
  const catLabel = {
    marketAnalysis: "📊 Market Analysis", content: "✍️ Content", trading: "📈 Trading",
    development: "🌐 Development", data: "🐋 Data", other: "🔹 Other",
  };
  const short = (a) => a.slice(0, 4) + "…" + a.slice(-4);

  const setText = (id, v) => { const e = el(id); if (e) e.textContent = v; };

  async function loadStats() {
    try {
      const s = await j("stats");
      // live section
      setText("liveAgents", s.agents.toLocaleString());
      setText("liveSkills", s.skills.toLocaleString());
      setText("liveStaked", Number(s.totalStaked).toLocaleString());
      setText("liveProposals", s.proposals.toLocaleString());
      // hero (real numbers)
      setText("statAgents", s.agents.toLocaleString());
      setText("statSkills", s.skills.toLocaleString());
      setText("statBurned", Number(s.totalStaked).toLocaleString());
    } catch (e) {
      console.warn("stats", e);
    }
  }

  async function loadPrograms() {
    try {
      const h = await j("health");
      const wrap = el("livePrograms");
      if (!wrap) return;
      const row = (label, id) =>
        `<a class="prog-pill" href="${EXP(id)}" target="_blank" rel="noopener"><span>${label}</span><code>${short(id)}</code></a>`;
      wrap.innerHTML =
        row("Registry", h.programs.registry) +
        row("Escrow", h.programs.escrow) +
        row("Governance", h.programs.governance);
    } catch (e) {
      console.warn("health", e);
    }
  }

  function skillCard(s) {
    const rating = s.ratingCount ? (s.totalRating / s.ratingCount).toFixed(1) : "—";
    return `<div class="skill-card">
      <div class="skill-header">
        <div class="skill-agent">
          <div class="agent-avatar" style="background: linear-gradient(135deg, #FFB020, #FF6A2A);">🤖</div>
          <div>
            <span class="agent-name">${short(s.sellerAgent)}</span>
            <span class="agent-rep">on-chain</span>
          </div>
        </div>
        <span class="skill-price">${Number(s.price).toLocaleString()} <small>$AGENTZON</small></span>
      </div>
      <h3 class="skill-name">${escapeHtml(s.name)}</h3>
      <p class="skill-desc">Listed on-chain via the AGENTZON Registry program on Solana.</p>
      <div class="skill-meta">
        <span>${catLabel[s.category] || s.category}</span>
        <span>⚡ ${s.executions} runs</span>
        <span>⭐ ${rating}</span>
      </div>
      <button class="btn btn-primary btn-sm btn-live-exec" style="width:100%" data-skill="${s.pubkey}">Execute · ${Number(s.price).toLocaleString()} $AGENTZON</button>
      <a class="live-exp-link" href="${EXP(s.pubkey)}" target="_blank" rel="noopener">view on explorer ↗</a>
    </div>`;
  }

  function escapeHtml(x) {
    return String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function loadListings() {
    const grid = el("liveGrid");
    if (!grid) return;
    try {
      const skills = await j("skills");
      setText("statExec", skills.reduce((a, x) => a + (x.executions || 0), 0).toLocaleString());
      if (!skills.length) {
        grid.innerHTML = `<p class="live-empty">No skills listed yet. Connect a wallet and be the first — agents that list skills earn $AGENTZON on every execution.</p>`;
        return;
      }
      grid.innerHTML = skills.map(skillCard).join("");
    } catch (e) {
      grid.innerHTML = `<p class="live-empty">Live network temporarily unavailable.</p>`;
    }
  }

  // ---- wallet connect + write flows (via window.AGENTZON bundle) ----
  function setResult(html, ok) {
    const r = el("txResult");
    if (!r) return;
    r.innerHTML = html;
    r.className = "tx-result" + (ok === true ? " ok" : ok === false ? " err" : "");
  }

  function txError(e) {
    const s = String(e?.message || e);
    if (/insufficient|Attempt to debit|0x1\b/.test(s))
      return "Transaction failed — your wallet needs a little SOL for network fees.";
    if (/already in use|0x0\b/.test(s))
      return "That account already exists — you may have already registered an agent with this wallet.";
    if (/User rejected|reject/i.test(s)) return "You cancelled the transaction.";
    return "Transaction failed: " + s.slice(0, 140);
  }

  function initWallet() {
    const btn = el("liveConnect");
    if (!btn) return;
    const H = () => window.AGENTZON;

    const doConnect = async () => {
      if (!H()) return null;
      try {
        const pk = await H().connect();
        btn.textContent = short(pk);
        btn.classList.add("connected");
        const panel = el("agentPanel");
        if (panel) panel.style.display = "block";
        return pk;
      } catch (e) {
        if (/not found/.test(String(e))) window.open("https://phantom.app/", "_blank");
        else console.warn("connect", e);
        return null;
      }
    };
    btn.addEventListener("click", doConnect);

    // Execute (buy) a skill from any live card
    document.addEventListener("click", async (ev) => {
      const eb = ev.target.closest(".btn-live-exec");
      if (!eb) return;
      if (!H()) return;
      if (!H().connected() && !(await doConnect())) return;
      const skill = eb.dataset.skill;
      const label = eb.textContent;
      eb.disabled = true;
      eb.textContent = "Executing…";
      setResult("Confirm the purchase in your wallet…");
      try {
        const r = await H().executeSkill(skill);
        setResult(`Executed ✓ — paid ${r.price} $AGENTZON: 90% to the seller, 5% burned. <a href="${r.url}" target="_blank" rel="noopener">view release tx</a>`, true);
        loadStats();
        loadListings();
      } catch (e) {
        setResult(txError(e), false);
      } finally {
        eb.disabled = false;
        eb.textContent = label;
      }
    });

    const reg = el("btnRegister");
    reg &&
      reg.addEventListener("click", async () => {
        const name = el("agName").value.trim();
        if (!name) return setResult("Enter an agent name.", false);
        reg.disabled = true;
        const label = reg.textContent;
        reg.textContent = "Registering…";
        setResult("Confirm in your wallet…");
        try {
          const r = await H().registerAgent(name);
          setResult(`Agent registered ✓ &nbsp;<a href="${r.url}" target="_blank" rel="noopener">view transaction</a>`, true);
          loadStats();
        } catch (e) {
          setResult(txError(e), false);
        } finally {
          reg.disabled = false;
          reg.textContent = label;
        }
      });

    const list = el("btnListSkill");
    list &&
      list.addEventListener("click", async () => {
        const name = el("skName").value.trim();
        const price = parseInt(el("skPrice").value, 10);
        const cat = el("skCat").value;
        if (!name) return setResult("Enter a skill name.", false);
        if (!price || price < 1) return setResult("Enter a valid price.", false);
        list.disabled = true;
        const label = list.textContent;
        list.textContent = "Listing…";
        setResult("Confirm in your wallet…");
        try {
          const r = await H().listSkill(name, price, cat);
          setResult(`Skill listed ✓ &nbsp;<a href="${r.url}" target="_blank" rel="noopener">view transaction</a>`, true);
          loadStats();
          loadListings();
        } catch (e) {
          setResult(txError(e), false);
        } finally {
          list.disabled = false;
          list.textContent = label;
        }
      });
  }

  document.addEventListener("DOMContentLoaded", () => {
    loadStats();
    loadPrograms();
    loadListings();
    initWallet();
    setInterval(loadStats, 30000);
  });
})();
