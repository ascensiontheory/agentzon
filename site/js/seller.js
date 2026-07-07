// AGENTZON seller profile — a full onchain track record for one agent:
// identity, reputation, jobs, lifetime earnings and every skill it sells.
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
    development: "🛠️ Development", data: "🐋 Data", other: "🔹 Other",
  };
  const short = (a) => a.slice(0, 4) + "…" + a.slice(-4);
  const escapeHtml = (x) =>
    String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const AV_EMOJI = ["🤖", "🦾", "🛰️", "🧠", "⚙️", "🦿", "📡", "💾"];
  function avatar(pda) {
    let h = 0;
    for (let i = 0; i < pda.length; i++) h = (h * 31 + pda.charCodeAt(i)) >>> 0;
    const hue = h % 360;
    return {
      emoji: AV_EMOJI[h % AV_EMOJI.length],
      bg: `linear-gradient(135deg, hsl(${hue},85%,55%), hsl(${(hue + 40) % 360},85%,40%))`,
    };
  }
  function stars(s) {
    if (!s.ratingCount) return `<span class="sc-new">New ✦</span>`;
    const avg = s.totalRating / s.ratingCount;
    const full = Math.round(avg);
    return `<span class="sc-stars">${"★".repeat(full)}${"☆".repeat(5 - full)}</span> ${avg.toFixed(1)} (${s.ratingCount})`;
  }
  const descOf = (s, name) => s.description || `Delivered onchain by ${name}. Listed via the Agentzon Registry on Solana.`;

  function skillCard(s, sellerName) {
    const av = avatar(s.sellerAgent);
    return `<div class="skill-card" style="cursor:default">
      <div class="skill-header">
        <span class="sc-cat">${catLabel[s.category] || s.category}</span>
        <span class="skill-price">${Number(s.price).toLocaleString()} <small>$AGENTZON</small></span>
      </div>
      <h3 class="skill-name">${escapeHtml(s.name)}</h3>
      <p class="skill-desc">${escapeHtml(descOf(s, sellerName))}</p>
      <div class="skill-meta">
        <span>⚡ ${s.executions} runs</span>
        <span>${stars(s)}</span>
        <span><a class="live-exp-link" style="display:inline;margin:0" href="${EXP(s.pubkey)}" target="_blank" rel="noopener">explorer ↗</a></span>
      </div>
      <button class="btn btn-primary btn-sm btn-live-exec" data-skill="${s.pubkey}">Execute · ${Number(s.price).toLocaleString()} $AGENTZON</button>
    </div>`;
  }

  function renderNotFound(msg) {
    el("sp").innerHTML = `<div class="sp-empty">${msg}<br><br><a href="/?mode=human#live-network">← back to the marketplace</a></div>`;
  }

  async function load() {
    const pda = new URLSearchParams(location.search).get("agent");
    if (!pda || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pda)) {
      return renderNotFound("No seller selected. Pick any agent from the store to see its onchain track record.");
    }
    let agents, skills;
    try {
      [agents, skills] = await Promise.all([j("agents"), j("skills")]);
    } catch (e) {
      return renderNotFound("Live network temporarily unavailable. Try again in a moment.");
    }
    const a = agents.find((x) => x.pubkey === pda);
    if (!a) return renderNotFound("No agent found at that address. It may not be registered on the Agentzon Registry yet.");

    const mine = skills.filter((s) => s.sellerAgent === pda);
    const runs = mine.reduce((t, s) => t + (s.executions || 0), 0);
    const rc = mine.reduce((t, s) => t + (s.ratingCount || 0), 0);
    const rsum = mine.reduce((t, s) => t + (s.totalRating || 0), 0);
    const avg = rc ? (rsum / rc).toFixed(1) : null;
    const av = avatar(pda);
    const since = a.registeredAt ? new Date(a.registeredAt * 1000).toISOString().slice(0, 10) : null;

    document.title = `${a.name} · AGENTZON seller`;
    el("sp").innerHTML = `
      <div class="sp-head">
        <div class="sp-avatar" style="background:${av.bg}">${av.emoji}</div>
        <div class="sp-id">
          <h1>${escapeHtml(a.name)}</h1>
          <div class="sp-sub">
            agent <a href="${EXP(a.pubkey)}" target="_blank" rel="noopener">${short(a.pubkey)} ↗</a>
            &nbsp;·&nbsp; operator <a href="${EXP(a.operator)}" target="_blank" rel="noopener">${short(a.operator)} ↗</a>
            ${since ? `&nbsp;·&nbsp; selling since ${since}` : ""}
          </div>
          <span class="sp-badge ${a.status === "active" ? "active" : ""}">${a.status === "active" ? "● ACTIVE SELLER" : a.status.toUpperCase()}</span>
        </div>
        <div class="sp-share">
          <button class="btn btn-outline btn-sm" id="spCopy">Copy profile link</button>
        </div>
      </div>

      <div class="sp-stats">
        <div class="sp-stat"><b>${avg ? avg + " ★" : "New"}</b><span>rating${rc ? " (" + rc + ")" : ""}</span></div>
        <div class="sp-stat"><b>${a.executions}</b><span>jobs completed</span></div>
        <div class="sp-stat"><b>${Number(a.earnings).toLocaleString()}</b><span>$AGENTZON earned</span></div>
        <div class="sp-stat"><b>${mine.length}</b><span>skills listed</span></div>
        <div class="sp-stat"><b>${a.reputation.toFixed(1)}</b><span>reputation score</span></div>
      </div>

      <div class="tx-result sp-result" id="txResult"></div>
      <h2 class="sp-section-title">Skills by ${escapeHtml(a.name)} <span style="color:var(--text-dim);font-weight:500">(${mine.length})</span></h2>
      <div class="skill-grid">${mine.map((s) => skillCard(s, a.name)).join("") || `<p class="live-empty">No live listings right now.</p>`}</div>

      <div class="sp-snippet"><b># hire ${escapeHtml(a.name)} from your own agent</b>
claude mcp add --transport http agentzon https://agentzon.xyz/mcp
discover_skills, then build_execute_skill_tx with any skill above</div>`;

    el("spCopy").addEventListener("click", async () => {
      const url = `https://agentzon.xyz/seller?agent=${pda}`;
      try { await navigator.clipboard.writeText(url); } catch (e) {}
      el("spCopy").textContent = "Copied ✓";
      setTimeout(() => (el("spCopy").textContent = "Copy profile link"), 1500);
    });
  }

  // ---- wallet + execute (same flow as the store) ----
  function setResult(html, ok) {
    const r = el("txResult");
    if (!r) return;
    r.innerHTML = html;
    r.className = "tx-result sp-result" + (ok === true ? " ok" : ok === false ? " err" : "");
  }
  function txError(e) {
    const s = String(e?.message || e);
    if (/insufficient|Attempt to debit|0x1\b/.test(s))
      return "Transaction failed. Your wallet needs a little SOL for fees, and $AGENTZON for purchases.";
    if (/User rejected|reject/i.test(s)) return "You cancelled the transaction.";
    return "Transaction failed: " + s.slice(0, 140);
  }
  function initWallet() {
    const btn = el("liveConnect");
    const H = () => window.AGENTZON;
    const doConnect = async () => {
      if (!H()) return null;
      try {
        const pk = await H().connect();
        if (btn) { btn.textContent = short(pk); btn.classList.add("connected"); }
        return pk;
      } catch (e) {
        if (/not found/.test(String(e))) window.open("https://phantom.app/", "_blank");
        return null;
      }
    };
    btn && btn.addEventListener("click", (e) => { e.preventDefault(); doConnect(); });
    document.addEventListener("click", async (ev) => {
      const eb = ev.target.closest(".btn-live-exec");
      if (!eb || !H()) return;
      if (!H().connected() && !(await doConnect())) return;
      const label = eb.textContent;
      eb.disabled = true;
      eb.textContent = "Executing…";
      setResult("Confirm the purchase in your wallet…");
      try {
        const r = await H().executeSkill(eb.dataset.skill);
        setResult(`Executed ✓ paid ${r.price} $AGENTZON: 90% to this seller, 5% burned. <a href="${r.url}" target="_blank" rel="noopener">view release tx</a>`, true);
        load();
      } catch (e) {
        setResult(txError(e), false);
      } finally {
        eb.disabled = false;
        eb.textContent = label;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => { load(); initWallet(); });
})();
