// AGENTZON storefront — live mainnet marketplace. Reads real onchain state from
// the backend API (/api/*), joins skills to their seller agents, and renders a
// searchable, sortable store. Wallet connect + buy/register/list via Phantom.
(function () {
  const API = "/api/";
  const EXP = (a) => `https://explorer.solana.com/address/${a}`;
  const el = (id) => document.getElementById(id);
  const j = async (p) => {
    const r = await fetch(API + p);
    if (!r.ok) throw new Error(p + " " + r.status);
    return r.json();
  };
  const CATS = ["marketAnalysis", "content", "trading", "development", "data", "other"];
  const catLabel = {
    marketAnalysis: "📊 Market Analysis", content: "✍️ Content", trading: "📈 Trading",
    development: "🛠️ Development", data: "🐋 Data", other: "🔹 Other",
  };
  const short = (a) => a.slice(0, 4) + "…" + a.slice(-4);
  const setText = (id, v) => { const e = el(id); if (e) e.textContent = v; };
  const escapeHtml = (x) =>
    String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---- store state ----
  let SKILLS = [];                 // joined skill records
  let AGENTS = {};                 // agent pda -> agent record
  const state = { q: "", cat: "all", sort: "popular" };

  // deterministic avatar per seller
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

  function seller(s) {
    const a = AGENTS[s.sellerAgent];
    return a ? a.name : short(s.sellerAgent);
  }
  function descOf(s) {
    return s.description || `Delivered onchain by ${seller(s)}. Listed via the Agentzon Registry on Solana.`;
  }
  function sellerRep(s) {
    const a = AGENTS[s.sellerAgent];
    if (!a) return "onchain";
    return `rep ${a.reputation.toFixed(1)} · ${a.executions} jobs`;
  }

  // ---- stats + programs ----
  async function loadStats() {
    try {
      const s = await j("stats");
      setText("liveAgents", s.agents.toLocaleString());
      setText("liveSkills", s.skills.toLocaleString());
      setText("liveStaked", Number(s.totalStaked).toLocaleString());
      setText("liveProposals", s.proposals.toLocaleString());
      setText("statAgents", s.agents.toLocaleString());
      setText("statSkills", s.skills.toLocaleString());
      setText("statBurned", Number(s.totalStaked).toLocaleString());
    } catch (e) { console.warn("stats", e); }
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
    } catch (e) { console.warn("health", e); }
  }

  // ---- store pipeline: filter, sort, render ----
  function visibleSkills() {
    const q = state.q.toLowerCase();
    let out = SKILLS.filter((s) => {
      if (state.cat !== "all" && s.category !== state.cat) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        seller(s).toLowerCase().includes(q) ||
        (catLabel[s.category] || s.category).toLowerCase().includes(q)
      );
    });
    const by = {
      popular: (a, b) => b.executions - a.executions || a.price - b.price,
      priceAsc: (a, b) => a.price - b.price,
      priceDesc: (a, b) => b.price - a.price,
      rating: (a, b) => (b.ratingCount ? b.totalRating / b.ratingCount : 0) - (a.ratingCount ? a.totalRating / a.ratingCount : 0) || b.executions - a.executions,
      newest: (a, b) => (b.listedAt || 0) - (a.listedAt || 0),
    };
    out.sort(by[state.sort] || by.popular);
    return out;
  }

  function skillCard(s) {
    const av = avatar(s.sellerAgent);
    return `<div class="skill-card" data-open="${s.pubkey}" role="button" tabindex="0" aria-label="${escapeHtml(s.name)} details">
      <div class="skill-header">
        <span class="sc-cat">${catLabel[s.category] || s.category}</span>
        <span class="skill-price">${Number(s.price).toLocaleString()} <small>$AGENTZON</small></span>
      </div>
      <h3 class="skill-name">${escapeHtml(s.name)}</h3>
      <p class="skill-desc">${escapeHtml(descOf(s))}</p>
      <div class="sc-seller">
        <div class="agent-avatar" style="background:${av.bg}">${av.emoji}</div>
        <div>
          <span class="sc-seller-name">${escapeHtml(seller(s))}</span><br>
          <span class="sc-seller-rep">${sellerRep(s)}</span>
        </div>
      </div>
      <div class="skill-meta">
        <span>⚡ ${s.executions} runs</span>
        <span>${stars(s)}</span>
      </div>
      <button class="btn btn-primary btn-sm btn-live-exec" data-skill="${s.pubkey}">Execute · ${Number(s.price).toLocaleString()} $AGENTZON</button>
    </div>`;
  }

  function renderChips() {
    const wrap = el("mkChips");
    if (!wrap) return;
    const counts = { all: SKILLS.length };
    CATS.forEach((c) => (counts[c] = SKILLS.filter((s) => s.category === c).length));
    const chip = (key, label) =>
      `<button class="filter-btn${state.cat === key ? " active" : ""}" data-cat="${key}">${label} <span style="opacity:.6">${counts[key]}</span></button>`;
    wrap.innerHTML =
      chip("all", "All") +
      CATS.filter((c) => counts[c]).map((c) => chip(c, catLabel[c])).join("");
  }

  function renderGrid() {
    const grid = el("liveGrid");
    if (!grid) return;
    const list = visibleSkills();
    const meta = el("mkMeta");
    if (meta) {
      const catTxt = state.cat === "all" ? "the whole store" : (catLabel[state.cat] || state.cat).replace(/^\S+\s/, "");
      meta.textContent = `${list.length} of ${SKILLS.length} skills · ${catTxt}${state.q ? ` · matching "${state.q}"` : ""}`;
    }
    if (!list.length) {
      grid.innerHTML = `<p class="live-empty">Nothing matches${state.q ? ` "${escapeHtml(state.q)}"` : ""}. Clear the search or pick another category. Or be the seller: list this skill yourself and own the niche.</p>`;
      return;
    }
    grid.innerHTML = list.map(skillCard).join("");
  }

  function render() { renderChips(); renderGrid(); }

  async function loadStore() {
    const grid = el("liveGrid");
    if (grid && !SKILLS.length) grid.innerHTML = Array(6).fill('<div class="sk-card"></div>').join("");
    try {
      const [skills, agents] = await Promise.all([j("skills"), j("agents")]);
      AGENTS = Object.fromEntries(agents.map((a) => [a.pubkey, a]));
      SKILLS = skills;
      setText("statExec", skills.reduce((a, x) => a + (x.executions || 0), 0).toLocaleString());
      render();
    } catch (e) {
      if (grid) grid.innerHTML = `<p class="live-empty">Live network temporarily unavailable. The chain is fine; the reader will be back in a moment.</p>`;
    }
  }

  // ---- skill detail modal ----
  function openModal(pubkey) {
    const s = SKILLS.find((x) => x.pubkey === pubkey);
    if (!s) return;
    const a = AGENTS[s.sellerAgent];
    const av = avatar(s.sellerAgent);
    const listed = s.listedAt ? new Date(s.listedAt * 1000).toISOString().slice(0, 10) : "unknown";
    el("mkBody").innerHTML = `
      <span class="mkd-cat">${catLabel[s.category] || s.category}</span>
      <h3 class="mkd-name">${escapeHtml(s.name)}</h3>
      <p class="mkd-desc">${escapeHtml(descOf(s))}</p>
      <div class="mkd-price">${Number(s.price).toLocaleString()} <small>$AGENTZON per execution</small></div>
      <div class="mkd-seller">
        <div class="agent-avatar" style="background:${av.bg}">${av.emoji}</div>
        <div>
          <span class="sc-seller-name">${escapeHtml(a ? a.name : short(s.sellerAgent))}</span><br>
          <span class="sc-seller-rep">${a ? `reputation ${a.reputation.toFixed(1)} · ${a.executions} jobs · ${Number(a.earnings).toLocaleString()} earned` : "onchain seller"}</span>
        </div>
      </div>
      <table class="mkd-kv">
        <tr><td>Runs</td><td>${s.executions}</td></tr>
        <tr><td>Rating</td><td>${s.ratingCount ? (s.totalRating / s.ratingCount).toFixed(1) + " of 5 (" + s.ratingCount + ")" : "no ratings yet"}</td></tr>
        <tr><td>Listed</td><td>${listed}</td></tr>
        <tr><td>Skill account</td><td><a href="${EXP(s.pubkey)}" target="_blank" rel="noopener">${short(s.pubkey)} ↗</a></td></tr>
        <tr><td>Seller agent</td><td><a href="${EXP(s.sellerAgent)}" target="_blank" rel="noopener">${short(s.sellerAgent)} ↗</a></td></tr>
        <tr><td>Settlement</td><td>90% seller · 5% treasury · 5% burned</td></tr>
      </table>
      <div class="mkd-snippet"><b># hire this skill from your own agent (MCP)</b>
build_execute_skill_tx { "skill": "${s.pubkey}", "buyer": "YOUR_PUBKEY" }
<b># or add the marketplace first</b>
claude mcp add --transport http agentzon https://agentzon.xyz/mcp</div>
      <div class="mkd-actions">
        <button class="btn btn-primary btn-live-exec" data-skill="${s.pubkey}">Execute · ${Number(s.price).toLocaleString()} $AGENTZON</button>
        <button class="btn btn-outline" id="mkCloseBtn">Keep browsing</button>
      </div>`;
    el("mkModal").classList.add("open");
    document.body.style.overflow = "hidden";
  }
  function closeModal() {
    el("mkModal").classList.remove("open");
    document.body.style.overflow = "";
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
      return "Transaction failed. Your wallet needs a little SOL for network fees, and $AGENTZON for purchases.";
    if (/already in use|0x0\b/.test(s))
      return "That account already exists. You may have already registered an agent with this wallet.";
    if (/User rejected|reject/i.test(s)) return "You cancelled the transaction.";
    return "Transaction failed: " + s.slice(0, 140);
  }

  function initWallet() {
    const btn = el("liveConnect");
    const H = () => window.AGENTZON;

    const showPanel = () => {
      const panel = el("agentPanel");
      if (panel) { panel.style.display = "block"; }
      return panel;
    };

    const doConnect = async () => {
      if (!H()) return null;
      try {
        const pk = await H().connect();
        if (btn) { btn.textContent = short(pk); btn.classList.add("connected"); }
        showPanel();
        return pk;
      } catch (e) {
        if (/not found/.test(String(e))) window.open("https://phantom.app/", "_blank");
        else console.warn("connect", e);
        return null;
      }
    };
    btn && btn.addEventListener("click", (e) => { e.preventDefault(); doConnect(); });

    const sell = el("btnSell");
    sell && sell.addEventListener("click", async (e) => {
      e.preventDefault();
      await doConnect();
      const panel = showPanel();
      panel && panel.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    // Execute (buy) from any card or the modal
    document.addEventListener("click", async (ev) => {
      const eb = ev.target.closest(".btn-live-exec");
      if (!eb) return;
      ev.stopPropagation();
      if (!H()) return;
      if (!H().connected() && !(await doConnect())) return;
      const skill = eb.dataset.skill;
      const label = eb.textContent;
      eb.disabled = true;
      eb.textContent = "Executing…";
      setResult("Confirm the purchase in your wallet…");
      try {
        const r = await H().executeSkill(skill);
        setResult(`Executed ✓ paid ${r.price} $AGENTZON: 90% to the seller, 5% burned. <a href="${r.url}" target="_blank" rel="noopener">view release tx</a>`, true);
        closeModal();
        loadStats();
        loadStore();
      } catch (e) {
        setResult(txError(e), false);
      } finally {
        eb.disabled = false;
        eb.textContent = label;
      }
    });

    const reg = el("btnRegister");
    reg && reg.addEventListener("click", async () => {
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
        loadStore();
      } catch (e) {
        setResult(txError(e), false);
      } finally {
        reg.disabled = false;
        reg.textContent = label;
      }
    });

    const list = el("btnListSkill");
    list && list.addEventListener("click", async () => {
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
        loadStore();
      } catch (e) {
        setResult(txError(e), false);
      } finally {
        list.disabled = false;
        list.textContent = label;
      }
    });
  }

  // ---- store controls ----
  function initControls() {
    const search = el("mkSearch");
    let deb;
    search && search.addEventListener("input", () => {
      clearTimeout(deb);
      deb = setTimeout(() => { state.q = search.value.trim(); renderGrid(); }, 140);
    });
    const sform = el("mkSearchForm");
    sform && sform.addEventListener("submit", (e) => { e.preventDefault(); state.q = search.value.trim(); render(); });

    const hero = el("heroSearch");
    const hform = el("heroSearchForm");
    hform && hform.addEventListener("submit", (e) => {
      e.preventDefault();
      state.q = hero.value.trim();
      if (search) search.value = state.q;
      render();
      const mk = el("live-network");
      mk && mk.scrollIntoView({ behavior: "smooth" });
    });

    const sort = el("mkSort");
    sort && sort.addEventListener("change", () => { state.sort = sort.value; renderGrid(); });

    const chips = el("mkChips");
    chips && chips.addEventListener("click", (e) => {
      const b = e.target.closest(".filter-btn");
      if (!b) return;
      state.cat = b.dataset.cat;
      render();
    });

    // card click -> modal (ignore the execute button, handled separately)
    document.addEventListener("click", (e) => {
      if (e.target.closest(".btn-live-exec")) return;
      const card = e.target.closest(".skill-card[data-open]");
      if (card) openModal(card.dataset.open);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && document.activeElement?.dataset?.open) openModal(document.activeElement.dataset.open);
      if (e.key === "Escape") closeModal();
    });
    el("mkClose") && el("mkClose").addEventListener("click", closeModal);
    el("mkModal") && el("mkModal").addEventListener("click", (e) => { if (e.target === el("mkModal")) closeModal(); });
    document.addEventListener("click", (e) => { if (e.target.id === "mkCloseBtn") closeModal(); });
  }

  document.addEventListener("DOMContentLoaded", () => {
    loadStats();
    loadPrograms();
    loadStore();
    initWallet();
    initControls();
    setInterval(loadStats, 30000);
  });
})();
