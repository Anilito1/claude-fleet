(function () {
  const vscode = acquireVsCodeApi();
  const bubblesEl = document.getElementById("bubbles");
  const linksEl = document.getElementById("links");
  const stageEl = document.getElementById("stage");
  const emptyEl = document.getElementById("empty");
  const drawerEl = document.getElementById("drawer");
  const drawerContent = document.getElementById("drawer-content");
  const scrimEl = document.getElementById("scrim");

  let state = { nodes: [], summary: {}, workspaceCwd: null };
  let workspaceCwd = null;
  let filterScope = "all"; // 'all' | 'workspace'
  let selectedId = null;
  const bubbleCache = new Map(); // id -> element
  const tweens = new Map(); // el -> {key, raf}

  // ---- SVG gradient defs ----
  linksEl.innerHTML =
    '<defs><linearGradient id="linkgrad" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="rgba(224,135,95,0.55)"/>' +
    '<stop offset="100%" stop-color="rgba(120,160,255,0.4)"/>' +
    "</linearGradient></defs>";

  // ---------- helpers ----------
  function fmtTokens(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n));
  }
  function fmtCost(n) {
    if (n >= 100) return "$" + n.toFixed(0);
    if (n >= 1) return "$" + n.toFixed(2);
    return "$" + n.toFixed(3);
  }
  function sumTokens(t) {
    return t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;
  }
  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return "à l'instant";
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + " min";
    const h = Math.floor(m / 60);
    if (h < 24) return h + " h";
    return Math.floor(h / 24) + " j";
  }
  function esc(s) {
    return (s || "").replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    );
  }
  function actIcon(kind) {
    switch (kind) {
      case "thinking": return "✷";
      case "tool": return "⚙";
      case "tool_result": return "↩";
      case "text": return "▸";
      case "done": return "✓";
      default: return "·";
    }
  }

  // ---- number tween (live counters) ----
  function tween(el, target, fmt, key) {
    const cur = parseFloat(el.dataset.val || "0");
    if (Math.abs(cur - target) < 1e-9) {
      el.textContent = fmt(target);
      el.dataset.val = String(target);
      return;
    }
    const prev = tweens.get(el);
    if (prev) cancelAnimationFrame(prev.raf);
    const start = performance.now();
    const dur = 480;
    const from = cur;
    function step(now) {
      const p = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      const v = from + (target - from) * e;
      el.textContent = fmt(v);
      el.dataset.val = String(v);
      if (p < 1) {
        tweens.set(el, { key, raf: requestAnimationFrame(step) });
      } else {
        el.textContent = fmt(target);
        el.dataset.val = String(target);
        tweens.delete(el);
      }
    }
    tweens.set(el, { key, raf: requestAnimationFrame(step) });
  }

  // ---------- bubble construction ----------
  function createBubble(node) {
    const el = document.createElement("div");
    el.className = "bubble " + node.kind;
    el.dataset.id = node.id;
    el.innerHTML = `
      <div class="b-top">
        <span class="dot"></span>
        ${node.kind === "agent" ? '<span class="chip agenttype"></span>' : ""}
        <span class="chip model"></span>
        <span class="b-spacer"></span>
        <span class="b-cost" data-val="0">$0.000</span>
      </div>
      <div class="b-title"></div>
      <div class="b-activity"><span class="act-ico"></span><span class="act-text"></span></div>
      <div class="b-foot">
        <span class="tok" data-val="0">0</span>
        <span class="sep">·</span>
        <span class="msgs"></span>
        <span class="sep">·</span>
        <span class="seen"></span>
      </div>
      <div class="work-bar"></div>`;
    el.addEventListener("click", () => openDrawer(node.id));
    return el;
  }

  function updateBubble(el, node) {
    const dot = el.querySelector(".dot");
    dot.className = "dot " + node.status;
    el.classList.toggle("working", !!node.working);
    el.classList.toggle("float", node.status !== "live");

    if (node.kind === "agent") {
      const at = el.querySelector(".agenttype");
      if (at) at.textContent = node.subtitle;
    }
    const modelChip = el.querySelector(".model");
    modelChip.className = "chip model " + node.modelFamily;
    modelChip.textContent = shortModel(node.model);

    el.querySelector(".b-title").textContent = node.title;

    const act = el.querySelector(".b-activity");
    act.className = "b-activity " + node.activityKind;
    el.querySelector(".act-ico").textContent = actIcon(
      node.status === "done" ? "done" : node.activityKind
    );
    el.querySelector(".act-text").textContent = node.activity;

    el.querySelector(".msgs").textContent = node.messageCount + " msg";
    el.querySelector(".seen").textContent = timeAgo(node.lastTs);

    const costEl = el.querySelector(".b-cost");
    costEl.classList.toggle("approx", !!node.approx);
    costEl.title = node.approx ? "Coût partiel (transcript volumineux lu depuis la fin)" : "";
    tween(costEl, node.cost.total, fmtCost, "cost");
    tween(el.querySelector(".tok"), sumTokens(node.tokens), fmtTokens, "tok");

    // managed badge
    let badge = el.querySelector(".badge-managed");
    if (node.managed && node.kind === "session") {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "badge-managed";
        badge.textContent = "pilotée";
        el.querySelector(".b-foot").appendChild(badge);
      }
    } else if (badge) {
      badge.remove();
    }
  }

  function shortModel(m) {
    if (!m || m === "—") return "—";
    return m.replace(/^claude-/, "").replace(/-(\d{8})$/, "");
  }

  // ---------- render ----------
  function visibleNodes() {
    let nodes = state.nodes;
    if (filterScope === "workspace" && workspaceCwd) {
      const inWs = (n) => n.cwd && samePath(n.cwd, workspaceCwd);
      const sessions = nodes.filter((n) => n.kind === "session" && inWs(n));
      const sessionIds = new Set(sessions.map((s) => s.id));
      nodes = nodes.filter(
        (n) => (n.kind === "session" && sessionIds.has(n.id)) ||
               (n.kind === "agent" && sessionIds.has(n.parentId))
      );
    }
    return nodes;
  }
  function samePath(a, b) {
    return a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
  }

  function render() {
    const nodes = visibleNodes();
    const sessions = nodes
      .filter((n) => n.kind === "session")
      .sort((a, b) => statusRank(a) - statusRank(b) || b.lastTs - a.lastTs);
    const agentsByParent = new Map();
    for (const n of nodes) {
      if (n.kind === "agent") {
        if (!agentsByParent.has(n.parentId)) agentsByParent.set(n.parentId, []);
        agentsByParent.get(n.parentId).push(n);
      }
    }

    emptyEl.classList.toggle("hidden", sessions.length > 0);

    const liveIds = new Set(nodes.map((n) => n.id));
    // remove stale bubbles
    for (const [id, el] of bubbleCache.entries()) {
      if (!liveIds.has(id)) {
        el.classList.add("leaving");
        setTimeout(() => el.remove(), 320);
        bubbleCache.delete(id);
      }
    }

    // rebuild group containers (reusing bubble elements)
    bubblesEl.innerHTML = "";
    for (const s of sessions) {
      const group = document.createElement("div");
      group.className = "group";
      group.dataset.session = s.id;

      const head = document.createElement("div");
      head.className = "group-head";
      head.appendChild(ensureBubble(s));
      group.appendChild(head);

      const agents = (agentsByParent.get(s.id) || []).sort(
        (a, b) => statusRank(a) - statusRank(b) || a.startedTs - b.startedTs
      );
      if (agents.length) {
        const row = document.createElement("div");
        row.className = "group-agents";
        for (const a of agents) row.appendChild(ensureBubble(a));
        group.appendChild(row);
      }
      bubblesEl.appendChild(group);
    }

    requestAnimationFrame(drawLinks);
    if (selectedId) refreshDrawer();
  }

  function statusRank(n) {
    return n.status === "live" ? 0 : n.status === "idle" ? 1 : 2;
  }

  function ensureBubble(node) {
    let el = bubbleCache.get(node.id);
    if (!el) {
      el = createBubble(node);
      bubbleCache.set(node.id, el);
    }
    updateBubble(el, node);
    return el;
  }

  // ---------- connectors ----------
  function drawLinks() {
    const defs = linksEl.querySelector("defs");
    linksEl.innerHTML = "";
    if (defs) linksEl.appendChild(defs);
    linksEl.style.width = stageEl.clientWidth + "px";
    linksEl.style.height = stageEl.scrollHeight + "px";

    const sr = stageEl.getBoundingClientRect();
    const ox = -sr.left + stageEl.scrollLeft;
    const oy = -sr.top + stageEl.scrollTop;

    const nodes = visibleNodes();
    for (const n of nodes) {
      if (n.kind !== "agent") continue;
      const childEl = bubbleCache.get(n.id);
      const parentEl = bubbleCache.get(n.parentId);
      if (!childEl || !parentEl) continue;
      const c = childEl.getBoundingClientRect();
      const p = parentEl.getBoundingClientRect();
      const x1 = p.left + p.width / 2 + ox;
      const y1 = p.bottom + oy;
      const x2 = c.left + c.width / 2 + ox;
      const y2 = c.top + oy;
      const dy = Math.max(18, (y2 - y1) / 2);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`);
      path.setAttribute("class", "link" + (n.status === "live" ? " live" : ""));
      linksEl.appendChild(path);
    }
  }

  // ---------- drawer ----------
  function openDrawer(id) {
    selectedId = id;
    drawerEl.classList.remove("hidden");
    scrimEl.classList.remove("hidden");
    refreshDrawer();
    vscode.postMessage({ type: "requestTail", nodeId: id });
  }
  function closeDrawer() {
    selectedId = null;
    drawerEl.classList.add("hidden");
    scrimEl.classList.add("hidden");
  }
  document.getElementById("drawer-close").addEventListener("click", closeDrawer);
  scrimEl.addEventListener("click", closeDrawer);

  function nodeById(id) {
    return state.nodes.find((n) => n.id === id);
  }

  function refreshDrawer() {
    const n = nodeById(selectedId);
    if (!n) {
      closeDrawer();
      return;
    }
    const t = n.tokens;
    const c = n.cost;
    const dur = n.lastTs && n.startedTs ? Math.max(0, n.lastTs - n.startedTs) : 0;
    const durStr = dur > 0 ? Math.round(dur / 60000) + " min" : "—";
    drawerContent.innerHTML = `
      <div class="d-title">${esc(n.title)}</div>
      <div class="d-sub">
        <span class="dot ${n.status}" style="display:inline-block"></span>
        <span class="chip ${n.modelFamily}">${esc(shortModel(n.model))}</span>
        <span class="chip agenttype">${esc(n.kind === "agent" ? n.subtitle : "session")}</span>
        ${n.status === "live" ? '<span style="color:var(--live)">en direct</span>' : ""}
      </div>

      <div class="d-section">
        <h4>Activité</h4>
        <div class="b-activity ${n.activityKind}" style="font-size:12.5px">
          <span class="act-ico">${actIcon(n.status === "done" ? "done" : n.activityKind)}</span>
          <span class="act-text" style="white-space:normal">${esc(n.activity)}</span>
        </div>
      </div>

      <div class="d-section">
        <h4>Coût API ${n.modelFamily}</h4>
        <div class="d-grid">
          <span class="k">Input</span><span class="v">${fmtCost(c.input)}</span>
          <span class="k">Output</span><span class="v">${fmtCost(c.output)}</span>
          <span class="k">Cache (écriture)</span><span class="v">${fmtCost(c.cacheWrite)}</span>
          <span class="k">Cache (lecture)</span><span class="v">${fmtCost(c.cacheRead)}</span>
          <span class="k d-total">Total</span><span class="v accent d-total">${n.approx ? "≈ " : ""}${fmtCost(c.total)}</span>
        </div>
        ${n.approx ? '<div class="tail-empty" style="margin-top:6px">≈ transcript volumineux : coût calculé sur la partie récente.</div>' : ""}
      </div>

      <div class="d-section">
        <h4>Tokens</h4>
        <div class="d-grid">
          <span class="k">Input</span><span class="v">${fmtTokens(t.input)}</span>
          <span class="k">Output</span><span class="v">${fmtTokens(t.output)}</span>
          <span class="k">Cache write</span><span class="v">${fmtTokens(t.cacheWrite5m + t.cacheWrite1h)}</span>
          <span class="k">Cache read</span><span class="v">${fmtTokens(t.cacheRead)}</span>
          <span class="k d-total">Total</span><span class="v d-total">${fmtTokens(sumTokens(t))}</span>
        </div>
      </div>

      <div class="d-section">
        <h4>Contexte</h4>
        <div class="d-grid">
          <span class="k">Messages</span><span class="v">${n.messageCount}</span>
          <span class="k">Durée active</span><span class="v">${durStr}</span>
          <span class="k">Dernière activité</span><span class="v">${timeAgo(n.lastTs)}</span>
          <span class="k">Dossier</span><span class="v" style="font-size:11px">${esc(folderOf(n.cwd))}</span>
          ${n.gitBranch ? `<span class="k">Branche</span><span class="v" style="font-size:11px">${esc(n.gitBranch)}</span>` : ""}
        </div>
      </div>

      <div class="d-actions">
        <button class="primary" id="act-resume">↩ Reprendre la main</button>
        <button id="act-copy">Copier resume</button>
        <button id="act-open">Transcript</button>
        <button id="act-reveal">Révéler</button>
      </div>
      <div class="d-section" id="tail-section">
        <h4>Flux en direct</h4>
        <div class="tail" id="tail-list"><div class="tail-empty">Chargement…</div></div>
      </div>`;

    document.getElementById("act-resume").addEventListener("click", () =>
      vscode.postMessage({ type: "resume", sessionId: n.sessionId, cwd: n.cwd })
    );
    document.getElementById("act-copy").addEventListener("click", () =>
      vscode.postMessage({ type: "copyResume", sessionId: n.sessionId })
    );
    document.getElementById("act-open").addEventListener("click", () =>
      vscode.postMessage({ type: "openTranscript", filePath: n.filePath })
    );
    document.getElementById("act-reveal").addEventListener("click", () =>
      vscode.postMessage({ type: "revealFolder", filePath: n.filePath })
    );
  }

  function folderOf(p) {
    if (!p) return "—";
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts.slice(-2).join("/") || p;
  }

  function renderTail(nodeId, lines) {
    if (nodeId !== selectedId) return;
    const list = document.getElementById("tail-list");
    if (!list) return;
    if (!lines.length) {
      list.innerHTML = '<div class="tail-empty">Aucun événement récent.</div>';
      return;
    }
    list.innerHTML = lines
      .slice()
      .reverse()
      .map(
        (l) => `
      <div class="tail-item">
        <div class="tl-head">
          <span class="tl-kind ${l.kind}">${l.kind}</span>
          <span class="tl-time">${timeAgo(l.ts)}</span>
        </div>
        <div class="tl-body">${esc(l.text)}</div>
      </div>`
      )
      .join("");
  }

  // poll tail while drawer open
  setInterval(() => {
    if (selectedId) vscode.postMessage({ type: "requestTail", nodeId: selectedId });
  }, 2500);

  // ---------- topbar ----------
  function updateStats() {
    const s = state.summary || {};
    tween(document.getElementById("stat-cost"), s.totalCost || 0, fmtCost, "c");
    tween(document.getElementById("stat-tokens"), s.totalTokens || 0, fmtTokens, "t");
    const live = document.getElementById("stat-live");
    live.textContent = s.liveCount || 0;
  }

  document.getElementById("btn-new").addEventListener("click", () =>
    vscode.postMessage({ type: "newSession", cwd: workspaceCwd })
  );
  const filterBtn = document.getElementById("filter-toggle");
  filterBtn.addEventListener("click", () => {
    filterScope = filterScope === "all" ? "workspace" : "all";
    filterBtn.textContent = filterScope === "all" ? "Tous" : "Ce projet";
    filterBtn.classList.toggle("primary", filterScope === "workspace");
    render();
    updateStatsFromVisible();
  });

  function updateStatsFromVisible() {
    if (filterScope === "all") {
      updateStats();
      return;
    }
    const nodes = visibleNodes();
    let cost = 0, tok = 0, live = 0;
    for (const n of nodes) {
      cost += n.cost.total;
      tok += sumTokens(n.tokens);
      if (n.status === "live") live++;
    }
    tween(document.getElementById("stat-cost"), cost, fmtCost, "c");
    tween(document.getElementById("stat-tokens"), tok, fmtTokens, "t");
    document.getElementById("stat-live").textContent = live;
  }

  // ---------- messaging ----------
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (msg.type === "state") {
      state = msg.state;
      render();
      updateStatsFromVisible();
    } else if (msg.type === "config") {
      workspaceCwd = msg.workspaceCwd;
    } else if (msg.type === "tail") {
      renderTail(msg.nodeId, msg.lines);
    }
  });

  window.addEventListener("resize", () => requestAnimationFrame(drawLinks));
  stageEl.addEventListener("scroll", () => requestAnimationFrame(drawLinks));

  // refresh relative times periodically
  setInterval(() => {
    for (const [id, el] of bubbleCache.entries()) {
      const n = nodeById(id);
      if (n) el.querySelector(".seen").textContent = timeAgo(n.lastTs);
    }
  }, 5000);

  vscode.postMessage({ type: "ready" });
})();
