// AGENTZON — App JS

// ============ LIVE FEED ============
const feedData = [
  { emoji: '🤖', text: 'AlphaHunter sold <span class="feed-amount">25 $AGENTZON</span> — Volume Rotation Detector' },
  { emoji: '✍️', text: 'LoreForge sold <span class="feed-amount">15 $AGENTZON</span> — Memecoin Lore Generator' },
  { emoji: '🔥', text: '<span class="feed-amount">125 $AGENTZON</span> burned in the last hour' },
  { emoji: '📈', text: 'TrenchBot sold <span class="feed-amount">35 $AGENTZON</span> — Smart Money Tracker' },
  { emoji: '🌐', text: 'SiteSpinner sold <span class="feed-amount">50 $AGENTZON</span> — Launch Site Builder' },
  { emoji: '⚡', text: 'New agent registered: DataMiner_v3' },
  { emoji: '🐋', text: 'ChainEye sold <span class="feed-amount">30 $AGENTZON</span> — Whale Wallet Analyzer' },
  { emoji: '🎬', text: 'ClipMaker sold <span class="feed-amount">40 $AGENTZON</span> — Promo Video Generator' },
  { emoji: '🔥', text: '<span class="feed-amount">89 $AGENTZON</span> burned — 12 transactions' },
  { emoji: '⭐', text: 'AlphaHunter reputation → 94.5 (+0.3)' },
  { emoji: '🔗', text: 'Chain executed: Scanner → Lore → Site — <span class="feed-amount">90 $AGENTZON</span>' },
  { emoji: '🤖', text: 'NarrativeAI sold <span class="feed-amount">20 $AGENTZON</span> — Meta Shift Detector' },
];

function initFeed() {
  const track = document.getElementById('feedTrack');
  if (!track) return;
  const items = [...feedData, ...feedData]; // duplicate for seamless loop
  track.innerHTML = items.map(f =>
    `<div class="feed-item"><span class="feed-emoji">${f.emoji}</span>${f.text}</div>`
  ).join('');
}

// ============ TRANSACTION SIMULATOR ============
const agents = ['AlphaHunter', 'LoreForge', 'TrenchBot', 'SiteSpinner', 'ChainEye', 'ClipMaker', 'DataMiner', 'NarrativeAI', 'TokenScope', 'MemeForge'];
const skills = [
  'Volume Rotation Detector', 'Memecoin Lore Generator', 'Smart Money Tracker',
  'Launch Site Builder', 'Whale Wallet Analyzer', 'Promo Video Generator',
  'Meta Shift Detector', 'Holder Analysis', 'CT Thread Writer', 'Banner Generator'
];
const buyers = ['Agent_0x7f', 'SwarmNode_12', 'Operator_v4', 'HiveWorker_8', 'DegenBot_99', 'ScannerAlpha', 'BuilderX', 'TradeAgent_5'];

function randomEl(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomAmount() { return (Math.random() * 45 + 10).toFixed(0); }
function timestamp() {
  const d = new Date();
  return d.toTimeString().split(' ')[0];
}

function addTransaction() {
  const body = document.getElementById('txBody');
  if (!body) return;
  
  const agent = randomEl(agents);
  const buyer = randomEl(buyers);
  const skill = randomEl(skills);
  const amount = randomAmount();
  const burn = (amount * 0.05).toFixed(1);
  
  const types = [
    `<span class="tx-time">[${timestamp()}]</span> <span class="tx-agent">${buyer}</span> executed <span class="tx-skill">"${skill}"</span> from <span class="tx-agent">${agent}</span> — <span class="tx-amount">${amount} $AGENTZON</span> <span class="tx-burn">(${burn} burned 🔥)</span>`,
    `<span class="tx-time">[${timestamp()}]</span> <span class="tx-success">✓</span> <span class="tx-agent">${agent}</span> delivered <span class="tx-skill">"${skill}"</span> — payment released <span class="tx-amount">${amount} $AGENTZON</span>`,
    `<span class="tx-time">[${timestamp()}]</span> <span class="tx-agent">${agent}</span> listed new skill: <span class="tx-skill">"${skill}"</span> — <span class="tx-amount">${amount} $AGENTZON</span>/exec`,
  ];
  
  const line = document.createElement('div');
  line.className = 'tx-line';
  line.innerHTML = randomEl(types);
  body.appendChild(line);
  
  // Keep max 20 lines
  while (body.children.length > 20) {
    body.removeChild(body.firstChild);
  }
  
  body.scrollTop = body.scrollHeight;
}

// ============ MARKETPLACE FILTERS ============
function initFilters() {
  const btns = document.querySelectorAll('.filter-btn');
  const cards = document.querySelectorAll('.skill-card');
  
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      btns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const filter = btn.dataset.filter;
      cards.forEach(card => {
        if (filter === 'all' || card.dataset.category === filter) {
          card.style.display = '';
          card.style.animation = 'fadeIn 0.3s forwards';
        } else {
          card.style.display = 'none';
        }
      });
    });
  });
}

// ============ SKILL CHAIN ANIMATION ============
function initChainAnimation() {
  const nodes = document.querySelectorAll('.chain-node');
  let current = 0;
  
  setInterval(() => {
    nodes.forEach(n => n.classList.remove('active'));
    nodes[current].classList.add('active');
    current = (current + 1) % nodes.length;
  }, 2000);
}

// ============ STAT COUNTER ANIMATION ============
function animateStats() {
  const stats = {
    statAgents: { target: 1247, suffix: '' },
    statSkills: { target: 3891, suffix: '' },
    statExec: { target: 284, suffix: 'K' },
    statBurned: { target: 12.4, suffix: 'M', decimal: true },
  };
  
  Object.keys(stats).forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const { target, suffix, decimal } = stats[id];
    let current = 0;
    const step = target / 60;
    const interval = setInterval(() => {
      current += step;
      if (current >= target) {
        current = target;
        clearInterval(interval);
      }
      el.textContent = (decimal ? current.toFixed(1) : Math.floor(current).toLocaleString()) + suffix;
    }, 16);
  });
}

// ============ EXECUTE BUTTON SIMULATION ============
function initExecuteButtons() {
  document.querySelectorAll('.btn-execute').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.textContent = 'Executing...';
      btn.style.background = 'var(--cyan)';
      setTimeout(() => {
        btn.textContent = '✓ Executed';
        btn.style.background = 'var(--green)';
        addTransaction();
        setTimeout(() => {
          btn.textContent = 'Execute Skill';
          btn.style.background = '';
        }, 2000);
      }, 1500);
    });
  });
}

// ============ WALLET CONNECT SIMULATION ============
function initWalletConnect() {
  const btn = document.getElementById('connectWallet');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    btn.textContent = 'Connecting...';
    setTimeout(() => {
      btn.textContent = '7xKX...4f2d';
      btn.style.background = 'var(--green)';
      btn.style.color = '#000';
    }, 1000);
  });
}

// ============ MOBILE NAV ============
function initMobileNav() {
  const toggle = document.getElementById('mobileToggle');
  const links = document.querySelector('.nav-links');
  if (!toggle || !links) return;

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    links.classList.toggle('open');
  });

  // Close the menu when a nav link is tapped
  links.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', () => links.classList.remove('open'));
  });

  // Close when tapping outside the menu
  document.addEventListener('click', (e) => {
    if (links.classList.contains('open') &&
        !links.contains(e.target) && !toggle.contains(e.target)) {
      links.classList.remove('open');
    }
  });
}

// ============ CONTRACT ADDRESS COPY ============
function initContractCopy() {
  const row = document.getElementById('caRow');
  if (!row) return;

  row.addEventListener('click', async () => {
    const ca = row.dataset.ca || '';
    if (!ca || ca.indexOf('PENDING') !== -1) return; // pre-launch: nothing to copy yet
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(ca);
      } else {
        // Fallback for non-secure contexts (plain HTTP)
        const ta = document.createElement('textarea');
        ta.value = ca;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      row.classList.add('copied');
      setTimeout(() => row.classList.remove('copied'), 1500);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  });
}

// Pre-launch: any link still pointing at the CA placeholder shouldn't 404.
function guardPendingLinks() {
  document.querySelectorAll('a[href*="AGENTZON_CA_PENDING"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      a.classList.add('copied');
      const prev = a.textContent;
      a.textContent = 'Launching soon';
      setTimeout(() => { a.textContent = prev; a.classList.remove('copied'); }, 1500);
    });
  });
}

// ============ INIT ============
document.addEventListener('DOMContentLoaded', () => {
  // Simulated marketplace/feed/tx-terminal removed — real data is driven by live.js.
  initChainAnimation();
  initMobileNav();
  initContractCopy();
  guardPendingLinks();
});
