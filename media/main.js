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
  let filterScope = "all";
  let showMode = "active"; // 'active' = only open/running sessions, 'recent' = include idle
  let selectedId = null;
  let drawerBuiltFor = null; // node id the drawer DOM was built for (avoid rebuilding -> avoid tail flicker)

  const bubbleCache = new Map(); // id -> .node element
  const linkCache = new Map(); // agentId -> <path>
  const tweens = new Map();
  let layoutNodes = []; // [{id, el, kind, status, parentId, bx, by, r, cx, cy, ax, ay, sx, sy, px, py}]
  let layoutById = new Map();
  const NODE_W = 150, SESSION_R = 33, AGENT_R = 23;

  // ---------- format ----------
  function fmtTokens(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n));
  }
  function fmtCost(n) {
    if (n >= 100) return "$" + n.toFixed(1);
    if (n >= 1) return "$" + n.toFixed(2);
    return "$" + n.toFixed(3);
  }
  function sumTokens(t) { return t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead; }
  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return "à l'instant";
    if (s < 60) return s + " s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + " min";
    const h = Math.floor(m / 60);
    if (h < 24) return h + " h";
    return Math.floor(h / 24) + " j";
  }
  function esc(s) {
    return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function actIcon(kind) {
    switch (kind) {
      case "thinking": return "✷";
      case "tool": return "›_";
      case "tool_result": return "↩";
      case "text": return "▍";
      case "done": return "✓";
      default: return "·";
    }
  }
  function shortModel(m) {
    if (!m || m === "—") return "—";
    return m.replace(/^claude-/, "").replace(/-(\d{8})$/, "");
  }

  // ---------- number tween ----------
  function tween(el, target, fmt) {
    const cur = parseFloat(el.dataset.val || "0");
    if (Math.abs(cur - target) < 1e-9) {
      el.textContent = fmt(target);
      el.dataset.val = String(target);
      return;
    }
    const prev = tweens.get(el);
    if (prev) cancelAnimationFrame(prev);
    const start = performance.now();
    const dur = 450;
    const from = cur;
    function step(now) {
      const p = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      const v = from + (target - from) * e;
      el.textContent = fmt(v);
      el.dataset.val = String(v);
      if (p < 1) tweens.set(el, requestAnimationFrame(step));
      else { el.textContent = fmt(target); el.dataset.val = String(target); tweens.delete(el); }
    }
    tweens.set(el, requestAnimationFrame(step));
  }

  // ---------- node (floating orb + caption) ----------
  function createNode(node) {
    const el = document.createElement("div");
    el.className = "node " + node.kind;
    el.dataset.id = node.id;
    el.style.transform = "translate3d(-9999px,-9999px,0)"; // hidden until first layout frame
    el.innerHTML = `
      <div class="orb"><span class="orb-ico"></span></div>
      <div class="caption">
        <div class="cap-title"></div>
        <div class="cap-act"><span class="ca-ico"></span><span class="ca-text"></span></div>
        <div class="cap-meta">
          <span class="cap-tag"></span>
          <span class="cap-cost" data-val="0">$0.000</span>
          <span class="cap-managed hidden" title="Pilotée par Fleet">●</span>
        </div>
      </div>`;
    el.addEventListener("click", () => openDrawer(node.id));
    return el;
  }

  function updateNode(el, node) {
    el.className =
      "node " + node.kind + " " + node.status +
      (node.working ? " working" : "") +
      (node.managed && node.kind === "session" ? " managed" : "");
    const ico = actIcon(node.status === "done" ? "done" : node.activityKind);
    el.querySelector(".orb-ico").textContent = ico;
    el.querySelector(".cap-title").textContent = node.title;
    const act = el.querySelector(".cap-act");
    act.className = "cap-act " + node.activityKind;
    el.querySelector(".ca-ico").textContent = ico;
    el.querySelector(".ca-text").textContent = node.activity;
    el.querySelector(".cap-tag").textContent =
      node.kind === "agent" ? node.subtitle : shortModel(node.model);
    const costEl = el.querySelector(".cap-cost");
    costEl.classList.toggle("approx", !!node.approx);
    tween(costEl, node.cost.total, fmtCost);
    el.querySelector(".cap-managed").classList.toggle(
      "hidden", !(node.managed && node.kind === "session")
    );
  }

  function ensureNode(node) {
    let el = bubbleCache.get(node.id);
    if (!el) { el = createNode(node); bubbleCache.set(node.id, el); bubblesEl.appendChild(el); }
    updateNode(el, node);
    return el;
  }

  // ---------- filter ----------
  function samePath(a, b) {
    return (a || "").replace(/[\\/]+$/, "").toLowerCase() === (b || "").replace(/[\\/]+$/, "").toLowerCase();
  }
  function computeNodes() {
    let nodes = state.nodes;

    // workspace filter
    if (filterScope === "workspace" && workspaceCwd) {
      const sessions = nodes.filter((n) => n.kind === "session" && samePath(n.cwd, workspaceCwd));
      const ids = new Set(sessions.map((s) => s.id));
      nodes = nodes.filter(
        (n) => (n.kind === "session" && ids.has(n.id)) || (n.kind === "agent" && ids.has(n.parentId))
      );
    }

    // a session counts as "open" if it is live itself OR has a live (working) agent
    const liveAgentParents = new Set(
      nodes.filter((n) => n.kind === "agent" && n.status === "live").map((n) => n.parentId)
    );

    if (showMode === "active") {
      const openSessions = nodes.filter(
        (n) => n.kind === "session" && (n.status === "live" || liveAgentParents.has(n.id))
      );
      const openIds = new Set(openSessions.map((s) => s.id));
      const openAgents = nodes.filter(
        (n) => n.kind === "agent" && n.status === "live" && openIds.has(n.parentId)
      );
      nodes = [...openSessions, ...openAgents];
    }

    // annotate: a session with a live agent is itself shown as live + working
    return nodes.map((n) => {
      if (n.kind === "session" && liveAgentParents.has(n.id)) {
        return { ...n, status: "live", working: true };
      }
      return n;
    });
  }
  function statusRank(n) { return n.status === "live" ? 0 : n.status === "idle" ? 1 : 2; }

  function setEmptyText() {
    emptyEl.innerHTML =
      '<div class="empty-glow"></div>' +
      (showMode === "active"
        ? "<p>Aucune session ouverte</p><span>Les sessions Claude Code en cours d'exécution apparaîtront ici, en direct. Bascule sur « Récentes » pour revoir les sessions inactives.</span>"
        : "<p>Aucune session récente</p><span>Lance une session Claude Code — elle apparaîtra ici.</span>");
  }

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  function removeNode(id) {
    const el = bubbleCache.get(id);
    if (!el) return;
    bubbleCache.delete(id);
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 280);
  }
  function pushLayout(arr, byId, node, el, bx, by, r, parentId) {
    const h = hashStr(node.id);
    const ln = {
      id: node.id, el, kind: node.kind, status: node.status, parentId: parentId || null,
      bx, by, r, cx: bx, cy: by,
      ax: node.kind === "session" ? 4.5 : 6.5,
      ay: node.kind === "session" ? 5.5 : 7.5,
      sx: 0.45 + (h % 35) / 100,
      sy: 0.4 + ((h >> 3) % 35) / 100,
      px: (h % 628) / 100,
      py: ((h >> 5) % 628) / 100,
    };
    arr.push(ln);
    byId.set(node.id, ln);
  }

  function render() {
    const nodes = computeNodes();
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
    if (sessions.length === 0) setEmptyText();

    const desired = new Set(nodes.map((n) => n.id));
    for (const id of [...bubbleCache.keys()]) if (!desired.has(id)) removeNode(id);

    const W = Math.max(320, bubblesEl.clientWidth || stageEl.clientWidth || 360);
    const SESSION_BLOCK = SESSION_R * 2 + 12 + 46;
    const AGENT_BLOCK = AGENT_R * 2 + 10 + 46;
    const AGENT_SPACING = NODE_W + 16;
    const BAND_GAP = 48;

    const newLayout = [];
    const byId = new Map();
    let y = 14;

    for (const s of sessions) {
      const sEl = ensureNode(s);
      pushLayout(newLayout, byId, s, sEl, W / 2, y + SESSION_R + 6, SESSION_R);
      let bandH = SESSION_BLOCK;

      const agents = (agentsByParent.get(s.id) || []).sort(
        (a, b) => statusRank(a) - statusRank(b) || a.startedTs - b.startedTs
      );
      if (agents.length) {
        const perRow = Math.max(1, Math.min(agents.length, Math.floor((W - 24) / AGENT_SPACING)));
        const rows = Math.ceil(agents.length / perRow);
        const agentsTop = y + SESSION_BLOCK + 24;
        agents.forEach((a, i) => {
          const row = Math.floor(i / perRow);
          const colCount = row < rows - 1 ? perRow : agents.length - perRow * (rows - 1);
          const col = i % perRow;
          const rowW = colCount * AGENT_SPACING;
          const startX = W / 2 - rowW / 2 + AGENT_SPACING / 2;
          const ax = startX + col * AGENT_SPACING;
          const ay = agentsTop + row * AGENT_BLOCK + AGENT_R;
          pushLayout(newLayout, byId, a, ensureNode(a), ax, ay, AGENT_R, s.id);
        });
        bandH = SESSION_BLOCK + 24 + rows * AGENT_BLOCK;
      }
      y += bandH + BAND_GAP;
    }

    bubblesEl.style.height = y + 20 + "px";
    layoutNodes = newLayout;
    layoutById = byId;

    syncDrawer();
  }

  // ---------- floating animation loop ----------
  function frame(t) {
    const tt = t * 0.001;
    for (const ln of layoutNodes) {
      const ox = Math.sin(tt * ln.sx + ln.px) * ln.ax;
      const oy = Math.sin(tt * ln.sy + ln.py) * ln.ay;
      ln.cx = ln.bx + ox;
      ln.cy = ln.by + oy;
      ln.el.style.transform =
        "translate3d(" + (ln.cx - NODE_W / 2).toFixed(1) + "px," + (ln.cy - ln.r).toFixed(1) + "px,0)";
    }
    drawLinks();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Rebuild the drawer DOM only when the selected node changes; otherwise update
  // live values in place so the "Flux en direct" list is never wiped (no flicker).
  function syncDrawer() {
    if (!selectedId) return;
    const n = nodeById(selectedId);
    if (!n) { closeDrawer(); return; }
    if (drawerBuiltFor !== selectedId) {
      buildDrawer(n);
      drawerBuiltFor = selectedId;
      vscode.postMessage({ type: "requestTail", nodeId: selectedId });
    } else {
      updateDrawerLive(n);
    }
  }

  // ---------- connectors (follow the floating orbs) ----------
  function drawLinks() {
    linksEl.style.width = stageEl.clientWidth + "px";
    linksEl.style.height = stageEl.scrollHeight + "px";
    const offL = bubblesEl.offsetLeft, offT = bubblesEl.offsetTop;
    const present = new Set();
    for (const ln of layoutNodes) {
      if (ln.kind !== "agent") continue;
      const p = layoutById.get(ln.parentId);
      if (!p) continue;
      // branch out from BELOW the parent's caption (not through its text)
      const x1 = p.cx + offL, y1 = p.cy + p.r + 58 + offT;
      const x2 = ln.cx + offL, y2 = ln.cy - ln.r + offT;
      const dy = Math.max(12, (y2 - y1) / 2);
      let path = linkCache.get(ln.id);
      if (!path) {
        path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        linksEl.appendChild(path);
        linkCache.set(ln.id, path);
      }
      path.setAttribute(
        "d",
        "M " + x1.toFixed(1) + " " + y1.toFixed(1) +
        " C " + x1.toFixed(1) + " " + (y1 + dy).toFixed(1) + ", " +
        x2.toFixed(1) + " " + (y2 - dy).toFixed(1) + ", " +
        x2.toFixed(1) + " " + y2.toFixed(1)
      );
      const cls = "link" + (ln.status === "live" ? " live" : "");
      if (path.getAttribute("class") !== cls) path.setAttribute("class", cls);
      present.add(ln.id);
    }
    for (const [id, path] of [...linkCache.entries()]) {
      if (!present.has(id)) { path.remove(); linkCache.delete(id); }
    }
  }

  // ---------- drawer ----------
  function nodeById(id) { return state.nodes.find((n) => n.id === id); }
  function folderOf(p) {
    if (!p) return "—";
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts.slice(-2).join("/") || p;
  }
  function openDrawer(id) {
    selectedId = id;
    drawerBuiltFor = null;
    drawerEl.classList.remove("hidden");
    scrimEl.classList.remove("hidden");
    syncDrawer();
  }
  function closeDrawer() {
    selectedId = null;
    drawerBuiltFor = null;
    drawerEl.classList.add("hidden");
    scrimEl.classList.add("hidden");
  }
  document.getElementById("drawer-close").addEventListener("click", closeDrawer);
  scrimEl.addEventListener("click", closeDrawer);

  function durStr(n) {
    const dur = n.lastTs && n.startedTs ? Math.max(0, n.lastTs - n.startedTs) : 0;
    return dur > 60000 ? Math.round(dur / 60000) + " min" : dur > 0 ? Math.round(dur / 1000) + " s" : "—";
  }

  function buildDrawer(n) {
    const t = n.tokens, c = n.cost;
    drawerContent.innerHTML = `
      <div class="d-title">${esc(n.title)}</div>
      <div class="d-sub">
        <span class="dot ${n.status}" id="d-dot"></span>
        <span class="chip model">${esc(shortModel(n.model))}</span>
        <span class="chip agenttype">${esc(n.kind === "agent" ? n.subtitle : "session")}</span>
        <span id="d-live" style="color:var(--green)${n.status === "live" ? "" : ";display:none"}">en direct</span>
      </div>
      <div class="d-section">
        <h4>Activité</h4>
        <div class="b-activity ${n.activityKind}" id="d-act" style="font-size:12px">
          <span class="act-ico" id="d-act-ico">${actIcon(n.status === "done" ? "done" : n.activityKind)}</span>
          <span class="act-text" id="d-act-text" style="white-space:normal">${esc(n.activity)}</span>
        </div>
      </div>
      <div class="d-section">
        <h4>Coût API · ${esc(n.modelFamily)}</h4>
        <div class="d-grid">
          <span class="k">Input</span><span class="v" id="d-c-in">${fmtCost(c.input)}</span>
          <span class="k">Output</span><span class="v" id="d-c-out">${fmtCost(c.output)}</span>
          <span class="k">Cache (écriture)</span><span class="v" id="d-c-cw">${fmtCost(c.cacheWrite)}</span>
          <span class="k">Cache (lecture)</span><span class="v" id="d-c-cr">${fmtCost(c.cacheRead)}</span>
          <span class="k d-total">Total</span><span class="v accent d-total" id="d-c-total">${n.approx ? "≈ " : ""}${fmtCost(c.total)}</span>
        </div>
        ${n.approx ? '<div class="tail-empty" style="margin-top:7px">≈ transcript volumineux : coût calculé sur la partie récente.</div>' : ""}
      </div>
      <div class="d-section">
        <h4>Tokens</h4>
        <div class="d-grid">
          <span class="k">Input</span><span class="v" id="d-t-in">${fmtTokens(t.input)}</span>
          <span class="k">Output</span><span class="v" id="d-t-out">${fmtTokens(t.output)}</span>
          <span class="k">Cache write</span><span class="v" id="d-t-cw">${fmtTokens(t.cacheWrite5m + t.cacheWrite1h)}</span>
          <span class="k">Cache read</span><span class="v" id="d-t-cr">${fmtTokens(t.cacheRead)}</span>
          <span class="k d-total">Total</span><span class="v d-total" id="d-t-total">${fmtTokens(sumTokens(t))}</span>
        </div>
      </div>
      <div class="d-section">
        <h4>Contexte</h4>
        <div class="d-grid">
          <span class="k">Messages</span><span class="v" id="d-msgs">${n.messageCount}</span>
          <span class="k">Durée active</span><span class="v" id="d-dur">${durStr(n)}</span>
          <span class="k">Dernière activité</span><span class="v" id="d-last">${timeAgo(n.lastTs)}</span>
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
      <div class="d-section">
        <h4>Flux en direct</h4>
        <div class="tail" id="tail-list"><div class="tail-empty">Chargement…</div></div>
      </div>`;
    document.getElementById("act-resume").addEventListener("click", () =>
      vscode.postMessage({ type: "resume", sessionId: n.sessionId, cwd: n.cwd }));
    document.getElementById("act-copy").addEventListener("click", () =>
      vscode.postMessage({ type: "copyResume", sessionId: n.sessionId }));
    document.getElementById("act-open").addEventListener("click", () =>
      vscode.postMessage({ type: "openTranscript", filePath: n.filePath }));
    document.getElementById("act-reveal").addEventListener("click", () =>
      vscode.postMessage({ type: "revealFolder", filePath: n.filePath }));
  }

  // In-place live update of the open drawer (never touches the "Flux en direct" list).
  function updateDrawerLive(n) {
    const set = (id, v) => { const el = document.getElementById(id); if (el && el.textContent !== v) el.textContent = v; };
    const dot = document.getElementById("d-dot"); if (dot) dot.className = "dot " + n.status;
    const live = document.getElementById("d-live"); if (live) live.style.display = n.status === "live" ? "" : "none";
    const act = document.getElementById("d-act"); if (act) act.className = "b-activity " + n.activityKind;
    set("d-act-ico", actIcon(n.status === "done" ? "done" : n.activityKind));
    set("d-act-text", n.activity);
    const c = n.cost, t = n.tokens;
    set("d-c-in", fmtCost(c.input)); set("d-c-out", fmtCost(c.output));
    set("d-c-cw", fmtCost(c.cacheWrite)); set("d-c-cr", fmtCost(c.cacheRead));
    set("d-c-total", (n.approx ? "≈ " : "") + fmtCost(c.total));
    set("d-t-in", fmtTokens(t.input)); set("d-t-out", fmtTokens(t.output));
    set("d-t-cw", fmtTokens(t.cacheWrite5m + t.cacheWrite1h)); set("d-t-cr", fmtTokens(t.cacheRead));
    set("d-t-total", fmtTokens(sumTokens(t)));
    set("d-msgs", String(n.messageCount));
    set("d-dur", durStr(n)); set("d-last", timeAgo(n.lastTs));
  }

  function renderTail(nodeId, lines) {
    if (nodeId !== selectedId) return;
    const list = document.getElementById("tail-list");
    if (!list) return;
    const sig = nodeId + ":" + lines.length + ":" + (lines.length ? lines[lines.length - 1].ts : 0);
    if (list.dataset.sig === sig) return; // unchanged -> don't re-render (no flicker)
    list.dataset.sig = sig;
    if (!lines.length) { list.innerHTML = '<div class="tail-empty">Aucun événement récent.</div>'; return; }
    list.innerHTML = lines.slice().reverse().map((l) => `
      <div class="tail-item">
        <div class="tl-head"><span class="tl-kind ${l.kind}">${l.kind}</span><span class="tl-time">${timeAgo(l.ts)}</span></div>
        <div class="tl-body">${esc(l.text)}</div>
      </div>`).join("");
  }
  setInterval(() => { if (selectedId) vscode.postMessage({ type: "requestTail", nodeId: selectedId }); }, 2500);

  // ---------- topbar ----------
  function aggStats() {
    // always reflect what is actually shown (respects active/recent + workspace filters)
    let cost = 0, tok = 0, live = 0;
    for (const n of computeNodes()) {
      cost += n.cost.total;
      tok += sumTokens(n.tokens);
      if (n.status === "live" && n.kind === "session") live++;
    }
    return { cost, tok, live };
  }
  function updateStats() {
    const a = aggStats();
    tween(document.getElementById("stat-cost"), a.cost, fmtCost);
    tween(document.getElementById("stat-tokens"), a.tok, fmtTokens);
    document.getElementById("stat-live").textContent = a.live;
  }

  document.getElementById("btn-new").addEventListener("click", () =>
    vscode.postMessage({ type: "newSession", cwd: workspaceCwd }));

  const modeBtn = document.getElementById("mode-toggle");
  if (modeBtn) {
    modeBtn.addEventListener("click", () => {
      showMode = showMode === "active" ? "recent" : "active";
      modeBtn.textContent = showMode === "active" ? "Actives" : "Récentes";
      modeBtn.classList.toggle("on", showMode === "active");
      render();
      updateStats();
    });
  }

  const filterBtn = document.getElementById("filter-toggle");
  filterBtn.addEventListener("click", () => {
    filterScope = filterScope === "all" ? "workspace" : "all";
    filterBtn.textContent = filterScope === "all" ? "Tous" : "Ce projet";
    filterBtn.classList.toggle("primary", filterScope === "workspace");
    render();
    updateStats();
  });

  // ---------- messaging ----------
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (msg.type === "state") { state = msg.state; render(); updateStats(); }
    else if (msg.type === "config") { workspaceCwd = msg.workspaceCwd; }
    else if (msg.type === "tail") { renderTail(msg.nodeId, msg.lines); }
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 120);
  });

  vscode.postMessage({ type: "ready" });
})();
