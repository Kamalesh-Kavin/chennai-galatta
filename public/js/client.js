// Chennai Galatta — Client
const socket = io();

// =====================
// SESSION (for reconnection)
// =====================
let sessionId = localStorage.getItem('cg_sessionId');
if (!sessionId) {
  sessionId = crypto.randomUUID();
  localStorage.setItem('cg_sessionId', sessionId);
}

// =====================
// STATE
// =====================
let gameState = null;
let myId = null;
let stationPositions = null;
let joined = false;

// Board zoom/pan
let boardZoom = 1;
let boardPanX = 0;
let boardPanY = 0;
let isPanning = false;
let panStart = { x: 0, y: 0 };
let panStartOffset = { x: 0, y: 0 };
let panMoved = false;

// Move selection
let selectedStation = null;
let validMoves = [];
let highlightedStations = new Set();

// Hover preview — shows reachable stations from any node
let hoveredStation = null;

// Human-controlled AI: tracks whether the current player can control the AI inspector whose turn it is
let canControlAI = false;
let controllingPlayerId = null; // the AI inspector id being controlled

// Keep-alive ping to prevent Render free-tier idle (50s timeout)
let keepAliveInterval = null;
function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => fetch('/health').catch(() => {}), 30000);
}
function stopKeepAlive() {
  clearInterval(keepAliveInterval);
  keepAliveInterval = null;
}

// =====================
// RECONNECTION
// =====================
// On every (re)connect, try to rejoin an existing game with our sessionId
socket.on('connect', () => {
  socket.emit('rejoin', { sessionId });
});

socket.on('rejoinResult', ({ ok, playerId }) => {
  if (ok) {
    myId = playerId;
    joined = true;
    console.log('Reconnected as', playerId);
  }
});

// Detective colors
const DET_COLORS = ['#e63946', '#457b9d', '#2ecc71', '#9b5de5', '#f77f00'];
const MRX_COLOR = '#ffd700';

const TICKET_COLORS = {
  taxi: '#e8a800',
  bus: '#2ecc71',
  underground: '#e63946',
  black: '#888',
};

const TICKET_LABELS = {
  taxi: 'Auto',
  bus: 'Bus',
  underground: 'Metro',
  black: 'Black',
};

// =====================
// SCREENS
// =====================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// =====================
// LOBBY
// =====================
document.getElementById('btn-join-mrx').addEventListener('click', () => joinAs('mrx'));
document.getElementById('btn-join-detective').addEventListener('click', () => joinAs('detective'));

function joinAs(role) {
  const name = document.getElementById('player-name').value.trim();
  if (!name) { document.getElementById('player-name').focus(); return; }
  socket.emit('join', { name, role, sessionId });
  joined = true;
  document.getElementById('btn-leave').style.display = '';
}

document.getElementById('player-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-join-detective').click();
});

document.getElementById('btn-leave').addEventListener('click', () => {
  socket.emit('leave');
  joined = false;
  document.getElementById('btn-leave').style.display = 'none';
});

document.getElementById('btn-start').addEventListener('click', () => {
  socket.emit('startGame');
});

document.getElementById('btn-reset').addEventListener('click', () => {
  if (confirm('Reset the game? Everyone returns to lobby.')) {
    socket.emit('resetGame');
  }
});

document.getElementById('btn-pause').addEventListener('click', () => {
  socket.emit('togglePause');
});

document.getElementById('btn-new-game').addEventListener('click', () => {
  socket.emit('resetGame');
  joined = false;
  myId = null;
  document.getElementById('game-over-overlay').style.display = 'none';
  document.getElementById('history-overlay').style.display = 'none';
});

socket.on('lobbyState', (lobby) => {
  showScreen('lobby-screen');
  stopKeepAlive();
  const list = document.getElementById('lobby-player-list');
  list.innerHTML = '';

  const allPlayers = Object.entries(lobby.players);
  if (allPlayers.length === 0) {
    list.innerHTML = '<div style="color:var(--text-dim);font-size:0.8rem">No players yet</div>';
  } else {
    for (const [id, p] of allPlayers) {
      const row = document.createElement('div');
      row.className = 'lobby-player-row';
      row.innerHTML = `
        <span>${escapeHTML(p.name)}${p.isAI ? ' <span style="color:var(--text-dim)">(AI)</span>' : ''}</span>
        <span class="lobby-player-role ${p.role}">${p.role === 'mrx' ? 'The Don' : 'Inspector'}</span>
      `;
      list.appendChild(row);
    }
  }

  // Enable start if at least 1 human
  const humanCount = allPlayers.filter(([, p]) => !p.isAI).length;
  document.getElementById('btn-start').disabled = humanCount === 0;
});

socket.on('error', ({ message }) => {
  alert(message);
});

// =====================
// GAME STATE
// =====================
socket.on('gameState', (state) => {
  gameState = state;
  myId = state.myId;
  if (state.stationPositions) stationPositions = state.stationPositions;

  showScreen('game-screen');

  // Keep-alive: active during gameplay
  if (state.phase === 'playing') {
    startKeepAlive();
  } else {
    stopKeepAlive();
  }

  // Request valid moves if it's my turn, OR if I can control an AI inspector
  const isMyTurn = myId && state.currentTurn === myId;
  canControlAI = !!(myId && state.humanControlledAI &&
    state.currentTurn !== myId &&
    state.players[state.currentTurn]?.isAI &&
    state.players[state.currentTurn]?.role === 'detective' &&
    state.players[myId]?.role === 'detective');
  controllingPlayerId = canControlAI ? state.currentTurn : null;

  if ((isMyTurn || canControlAI) && state.phase === 'playing' && !state.paused) {
    socket.emit('getValidMoves', null, (moves) => {
      validMoves = moves;
      highlightedStations = new Set(moves.map(m => m.station));
      renderActionBar();
      renderBoard();
    });
  } else {
    validMoves = [];
    highlightedStations.clear();
  }

  renderUI();
  renderBoard();

  // Game over
  if (state.phase === 'ended') {
    showGameOver();
  }
});

// =====================
// UI RENDERING
// =====================
function renderUI() {
  if (!gameState) return;

  // Round info
  document.getElementById('round-info').textContent =
    `Round ${gameState.round}/${gameState.maxRounds}`;

  // Pause button
  const pauseBtn = document.getElementById('btn-pause');
  if (gameState.phase === 'playing') {
    pauseBtn.style.display = '';
    pauseBtn.textContent = gameState.paused ? 'Resume' : 'Pause';
    if (gameState.paused) {
      pauseBtn.classList.add('btn-paused');
    } else {
      pauseBtn.classList.remove('btn-paused');
    }
  } else {
    pauseBtn.style.display = 'none';
  }

  // Turn info
  const currentPlayer = gameState.players[gameState.currentTurn];
  const isMyTurn = myId && gameState.currentTurn === myId;

  if (gameState.paused) {
    document.getElementById('turn-info').textContent = 'PAUSED';
    document.getElementById('turn-info').style.color = 'var(--gold)';
  } else if (gameState.phase === 'ended') {
    document.getElementById('turn-info').textContent = 'Game Over';
    document.getElementById('turn-info').style.color = 'var(--gold)';
  } else if (isMyTurn) {
    document.getElementById('turn-info').textContent = 'Your turn!';
    document.getElementById('turn-info').style.color = 'var(--gold)';
  } else if (canControlAI && currentPlayer) {
    document.getElementById('turn-info').textContent = `Control ${currentPlayer.name}`;
    document.getElementById('turn-info').style.color = 'var(--gold)';
  } else if (currentPlayer) {
    document.getElementById('turn-info').textContent = `${currentPlayer.name}'s turn`;
    document.getElementById('turn-info').style.color = 'var(--text)';
  }

  // Double move indicator
  if (gameState.isDoubleMoveFirstHalf && !gameState.paused) {
    document.getElementById('turn-info').textContent += ' (Double Move!)';
  }

  // Travel log
  renderTravelLog();

  // My info
  renderMyInfo();

  // Player list
  renderPlayerList();

  // Action bar
  renderActionBar();
}

function renderTravelLog() {
  const log = document.getElementById('travel-log');
  log.innerHTML = '';

  if (!gameState.travelLog || gameState.travelLog.length === 0) {
    log.innerHTML = '<div style="color:var(--text-dim);font-size:0.75rem">No moves yet</div>';
    return;
  }

  for (const entry of gameState.travelLog) {
    const div = document.createElement('div');
    div.className = 'log-entry' + (entry.revealed ? ' revealed' : '');
    div.innerHTML = `
      <span class="log-round">R${entry.round}</span>
      <span class="log-ticket ticket-${entry.ticket}">${TICKET_LABELS[entry.ticket] || '?'}</span>
      ${entry.station ? `<span class="log-station">${entry.station}</span>` : ''}
    `;
    log.appendChild(div);
  }
}

function renderMyInfo() {
  if (!myId || !gameState.tickets[myId]) {
    document.getElementById('my-info-panel').style.display = 'none';
    return;
  }
  document.getElementById('my-info-panel').style.display = '';

  const role = gameState.players[myId]?.role;
  document.getElementById('my-role-title').textContent =
    role === 'mrx' ? 'The Don' : 'Inspector';

  const tickets = gameState.tickets[myId];
  const container = document.getElementById('my-tickets');
  container.innerHTML = '';

  const types = role === 'mrx'
    ? ['taxi', 'bus', 'underground', 'black']
    : ['taxi', 'bus', 'underground'];

  for (const type of types) {
    if (tickets[type] === undefined) continue;
    const badge = document.createElement('div');
    badge.className = 'ticket-badge';
    badge.innerHTML = `
      <span class="ticket-icon ${type}"></span>
      <span>${TICKET_LABELS[type]}: ${type === 'taxi' && tickets[type] > 50 ? '\u221e' : tickets[type]}</span>
    `;
    container.appendChild(badge);
  }

  if (role === 'mrx' && tickets.doubleMoves !== undefined) {
    const badge = document.createElement('div');
    badge.className = 'ticket-badge';
    badge.innerHTML = `
      <span class="ticket-icon double"></span>
      <span>2x Move: ${tickets.doubleMoves}</span>
    `;
    container.appendChild(badge);
  }
}

function renderPlayerList() {
  const list = document.getElementById('player-list');
  list.innerHTML = '';

  if (!gameState.turnOrder) return;

  for (let i = 0; i < gameState.turnOrder.length; i++) {
    const pid = gameState.turnOrder[i];
    const p = gameState.players[pid];
    if (!p) continue;

    const isMrX = pid === gameState.mrX;
    const isCurrentTurn = pid === gameState.currentTurn;
    const isControlled = canControlAI && pid === controllingPlayerId;
    const color = isMrX ? MRX_COLOR : DET_COLORS[(i - 1) % DET_COLORS.length];

    const row = document.createElement('div');
    row.className = 'player-row' +
      (isCurrentTurn ? ' active-turn' : '') +
      (isControlled ? ' ai-controlled' : '') +
      (p.stranded ? ' stranded' : '');

    const station = gameState.positions[pid];
    const stationText = station ? `#${station}` : (isMrX ? '?' : '');
    const controlTag = isControlled ? ' <span class="control-tag">CTRL</span>' : '';

    row.innerHTML = `
      <span class="player-name">
        <span class="player-dot" style="background:${color}"></span>
        ${escapeHTML(p.name)}${pid === myId ? ' (You)' : ''}${controlTag}
      </span>
      <span class="player-station">${stationText}</span>
    `;
    list.appendChild(row);
  }
}

function renderActionBar() {
  const container = document.getElementById('move-options');
  container.innerHTML = '';

  if (!gameState || gameState.phase !== 'playing') return;

  if (gameState.paused) {
    container.innerHTML = '<span class="action-label">Game is paused</span>';
    return;
  }

  const isMyTurn = myId && gameState.currentTurn === myId;

  if (!myId || (!isMyTurn && !canControlAI)) {
    container.innerHTML = '<span class="action-label">Waiting for other players...</span>';
    return;
  }

  // Show who we're controlling when in AI control mode
  if (canControlAI) {
    const aiPlayer = gameState.players[controllingPlayerId];
    container.insertAdjacentHTML('beforeend',
      `<span class="action-label ai-control-label">Controlling ${escapeHTML(aiPlayer?.name || 'AI Inspector')}:</span>`);
  }

  const isMrX = myId === gameState.mrX;

  // Double move button for Mr. X (only when it's actually Mr. X's own turn, not AI control)
  if (isMrX && isMyTurn && !gameState.isDoubleMoveFirstHalf) {
    const tickets = gameState.tickets[myId];
    if (tickets && tickets.doubleMoves > 0) {
      const btn = document.createElement('button');
      btn.className = 'double-move-btn';
      btn.textContent = `Double Move (${tickets.doubleMoves} left)`;
      btn.addEventListener('click', () => {
        socket.emit('useDoubleMove');
      });
      container.appendChild(btn);
    }
  }

  if (validMoves.length === 0) {
    container.innerHTML += '<span class="action-label">No valid moves — you are stranded!</span>';
    return;
  }

  container.insertAdjacentHTML('beforeend', '<span class="action-label">Move to:</span>');

  // Group moves by station
  const byStation = {};
  for (const m of validMoves) {
    if (!byStation[m.station]) byStation[m.station] = [];
    byStation[m.station].push(m.ticket);
  }

  // Sort by station number
  const sorted = Object.entries(byStation).sort((a, b) => Number(a[0]) - Number(b[0]));

  for (const [station, tickets] of sorted) {
    for (const ticket of tickets) {
      const btn = document.createElement('button');
      btn.className = 'move-btn';
      if (Number(station) === selectedStation) btn.classList.add('selected');
      btn.innerHTML = `
        <span class="ticket-dot ${ticket}"></span>
        #${station}
      `;
      btn.addEventListener('click', () => {
        socket.emit('move', { destination: Number(station), ticket });
        selectedStation = null;
      });
      btn.addEventListener('mouseenter', () => {
        selectedStation = Number(station);
        renderBoard();
      });
      btn.addEventListener('mouseleave', () => {
        selectedStation = null;
        renderBoard();
      });
      container.appendChild(btn);
    }
  }
}

function showGameOver() {
  const overlay = document.getElementById('game-over-overlay');
  overlay.style.display = 'flex';
  document.getElementById('game-over-title').textContent =
    gameState.winner === 'mrx' ? 'The Don Escapes!' : 'Inspectors Win!';
  document.getElementById('game-over-reason').textContent = gameState.winReason || '';

  // Build stats
  const statsEl = document.getElementById('game-over-stats');
  statsEl.innerHTML = '';

  const totalRounds = gameState.round;
  const totalMoves = (gameState.history || []).filter(h => h.move).length;

  let statsHTML = `<div class="stats-row"><span>Rounds played</span><span>${totalRounds}</span></div>`;
  statsHTML += `<div class="stats-row"><span>Total moves</span><span>${totalMoves}</span></div>`;

  // Count tickets used per type from travel log (Don's moves)
  if (gameState.travelLog) {
    const ticketCounts = {};
    for (const entry of gameState.travelLog) {
      ticketCounts[entry.ticket] = (ticketCounts[entry.ticket] || 0) + 1;
    }
    const donTickets = Object.entries(ticketCounts)
      .map(([t, c]) => `${TICKET_LABELS[t] || t}: ${c}`)
      .join(', ');
    if (donTickets) {
      statsHTML += `<div class="stats-row"><span>Don's tickets used</span><span>${donTickets}</span></div>`;
    }
  }

  statsEl.innerHTML = statsHTML;
}

// =====================
// BOARD RENDERING
// =====================
const canvas = document.getElementById('board-canvas');
const ctx = canvas.getContext('2d');

// Pre-built sets for station types (populated when adjacency arrives)
let undergroundStations = new Set();
let busStations = new Set();
let ferryStations = new Set();

// Load SVG map background — two versions: with and without district name labels
// Labels are hidden at default zoom and shown when zoomed in (>= 1.5x)
let mapBgClean = null;   // no district labels
let mapBgLabeled = null;  // with district labels
let mapBgCleanLoaded = false;
let mapBgLabeledLoaded = false;

// Fetch SVG source, create two blob URLs
fetch('/img/chennai-map.svg')
  .then(r => r.text())
  .then(svgText => {
    // Labeled version — original SVG
    const labeledBlob = new Blob([svgText], { type: 'image/svg+xml' });
    const labeledUrl = URL.createObjectURL(labeledBlob);
    mapBgLabeled = new Image();
    mapBgLabeled.onload = () => { mapBgLabeledLoaded = true; renderBoard(); };
    mapBgLabeled.src = labeledUrl;

    // Clean version — hide the district labels group
    const cleanSvg = svgText.replace(
      /(<g\s+font-family="Georgia[^"]*"[^>]*fill="#8a7a60"[^>]*>)/,
      '$1<g display="none">'
    ).replace(
      /(<\/g>\s*\n\s*<!-- =+\s*-->\s*\n\s*<!-- LANDMARK MARKERS)/,
      '</g>$1'
    );
    const cleanBlob = new Blob([cleanSvg], { type: 'image/svg+xml' });
    const cleanUrl = URL.createObjectURL(cleanBlob);
    mapBgClean = new Image();
    mapBgClean.onload = () => { mapBgCleanLoaded = true; renderBoard(); };
    mapBgClean.src = cleanUrl;
  });

// Animation frame for pulsing highlights
let _animFrame = 0;
let _animRAF = null;
function startBoardAnimation() {
  if (_animRAF) return;
  function tick() {
    _animFrame = (Date.now() % 2000) / 2000; // 0-1 cycle every 2s
    renderBoard();
    _animRAF = requestAnimationFrame(tick);
  }
  _animRAF = requestAnimationFrame(tick);
}
function stopBoardAnimation() {
  if (_animRAF) { cancelAnimationFrame(_animRAF); _animRAF = null; }
}

function renderBoard() {
  if (!stationPositions) return;

  const container = document.getElementById('board-container');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = container.clientWidth * dpr;
  canvas.height = container.clientHeight * dpr;
  canvas.style.width = container.clientWidth + 'px';
  canvas.style.height = container.clientHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const cw = container.clientWidth;
  const ch = container.clientHeight;

  // Compute scale to fit the 1000x700 map into the canvas
  const mapW = 1000, mapH = 700;
  const baseScale = Math.min(cw / mapW, ch / mapH) * 1.08;
  const scale = baseScale * boardZoom;
  const offsetX = cw / 2 + boardPanX;
  const offsetY = ch / 2 + boardPanY;

  // Transform: station coords (0-1000, 0-700) -> canvas pixel
  function toCanvas(station) {
    const pos = stationPositions[station];
    if (!pos) return { x: 0, y: 0 };
    return {
      x: offsetX + (pos.x - mapW / 2) * scale,
      y: offsetY + (pos.y - mapH / 2) * scale,
    };
  }

  // === BACKGROUND ===
  // Fill with a neutral matching color first
  ctx.fillStyle = '#e8dcc0';
  ctx.fillRect(0, 0, cw, ch);

  // Draw the SVG map image — show district labels only when zoomed in
  const useLabeled = boardZoom >= 1.5 && mapBgLabeledLoaded;
  const bgImg = useLabeled ? mapBgLabeled : (mapBgCleanLoaded ? mapBgClean : null);
  if (bgImg) {
    const imgX = offsetX - (mapW / 2) * scale;
    const imgY = offsetY - (mapH / 2) * scale;
    const imgW = mapW * scale;
    const imgH = mapH * scale;
    ctx.drawImage(bgImg, imgX, imgY, imgW, imgH);
  }

  // === CONNECTIONS ===
  drawConnections(ctx, toCanvas, scale, baseScale);

  // === STATIONS ===
  const nodeRadius = Math.max(7, 11 * scale / baseScale);
  drawStations(ctx, toCanvas, nodeRadius, scale, baseScale);

  // === PLAYER TOKENS ===
  drawPlayers(ctx, toCanvas, nodeRadius, scale, baseScale);

  // === HOVER PREVIEW (reachable stations from hovered node) ===
  if (hoveredStation && !highlightedStations.has(hoveredStation)) {
    drawHoverPreview(ctx, toCanvas, nodeRadius, scale, baseScale);
  }

  // Start/stop animation for highlighted stations and current-turn glow
  const needsAnimation = highlightedStations.size > 0 ||
    (gameState && gameState.phase === 'playing' && gameState.currentTurn);
  if (needsAnimation) {
    startBoardAnimation();
  } else if (_animRAF) {
    stopBoardAnimation();
  }
}

// Connections that must be drawn as curves to avoid passing through unconnected stations.
// key: "min-max" station pair, value: curve offset perpendicular to the line (positive = curve left/up, negative = right/down)
// The magnitude controls how far the arc bends (in map-coord pixels).
// Manually tuned for the original board positions.
const CURVED_CONNECTIONS = {
  '173-189': -50,   // catastrophic: passes through 6 stations. Curve south (below bottom row)
  '172-194': 50,    // passes through 5 stations inc. 193. Curve north (above)
  '128-188': -35,   // passes directly through station 160. Curve south
  '171-175': -25,   // passes directly through station 174. Curve south
  '155-198': -35,   // passes near station 169. Curve south
  '194-195': -25,   // passes near station 193. Curve south (below)
  '129-135': 25,    // passes near station 128. Curve north
  '91-107': -20,    // passes near station 106. Curve south
};

function drawConnections(ctx, toCanvas, scale, baseScale) {
  if (!window._adjacency) return;

  const drawn = new Set();
  // Draw order: taxi first (underneath), then bus, underground, ferry on top
  const lineConfigs = [
    { type: 'taxi',        adj: window._adjacency.taxi,        color: '#e8a800', width: 2, alpha: 0.75, dash: null },
    { type: 'bus',         adj: window._adjacency.bus,         color: '#18874a', width: 2.5, alpha: 0.75, dash: null },
    { type: 'underground', adj: window._adjacency.underground, color: '#cc2233', width: 4,   alpha: 0.8,  dash: null },
    { type: 'ferry',       adj: window._adjacency.ferry,       color: '#2a5580', width: 2.5, alpha: 0.7,  dash: [8, 5] },
  ];

  for (const cfg of lineConfigs) {
    if (!cfg.adj) continue;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const [s, neighbors] of Object.entries(cfg.adj)) {
      for (const n of neighbors) {
        const key = `${cfg.type}-${Math.min(s, n)}-${Math.max(s, n)}`;
        if (drawn.has(key)) continue;
        drawn.add(key);

        const sNum = Number(s), nNum = Number(n);
        const from = toCanvas(sNum);
        const to = toCanvas(nNum);
        const scaleMul = scale > 0.5 ? 1 : 0.6;

        // Check if this connection needs to be curved
        const pairKey = Math.min(sNum, nNum) + '-' + Math.max(sNum, nNum);
        const curveOffset = CURVED_CONNECTIONS[pairKey];

        // Helper to draw path (straight or curved)
        function tracePath() {
          ctx.beginPath();
          ctx.moveTo(from.x, from.y);
          if (curveOffset) {
            // Quadratic bezier: compute control point perpendicular to midpoint
            const mx = (from.x + to.x) / 2;
            const my = (from.y + to.y) / 2;
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            // Perpendicular unit vector
            const px = -dy / len;
            const py = dx / len;
            const offsetScaled = curveOffset * scale;
            ctx.quadraticCurveTo(mx + px * offsetScaled, my + py * offsetScaled, to.x, to.y);
          } else {
            ctx.lineTo(to.x, to.y);
          }
        }

        // White outline for bus/underground to separate from map
        if (cfg.type === 'underground' || cfg.type === 'bus') {
          tracePath();
          ctx.strokeStyle = 'rgba(255,255,255,0.5)';
          ctx.lineWidth = (cfg.width + 2) * scaleMul;
          ctx.globalAlpha = cfg.alpha * 0.4;
          ctx.stroke();
        }

        // Main line
        tracePath();
        ctx.strokeStyle = cfg.color;
        ctx.lineWidth = cfg.width * scaleMul;
        ctx.globalAlpha = cfg.alpha;
        if (cfg.dash) ctx.setLineDash(cfg.dash);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  ctx.globalAlpha = 1;
}

function drawStations(ctx, toCanvas, nodeRadius, scale, baseScale) {
  const allStations = Object.keys(stationPositions).map(Number);
  const fontSize = Math.max(6, 9 * scale / baseScale);
  const pulse = 0.5 + Math.sin(_animFrame * Math.PI * 2) * 0.5; // 0-1

  for (const s of allStations) {
    const { x, y } = toCanvas(s);
    let radius = nodeRadius;
    const isUnderground = undergroundStations.has(s);
    const isBus = busStations.has(s);
    const isFerry = ferryStations.has(s);
    const isHighlighted = highlightedStations.has(s);
    const isSelected = s === selectedStation;
    const isLastKnown = gameState && s === gameState.mrXLastKnown;

    // --- Highlighted station glow (valid move) ---
    if (isHighlighted) {
      radius = nodeRadius * 1.15;
      const glowAlpha = 0.2 + pulse * 0.3;
      ctx.beginPath();
      ctx.arc(x, y, radius * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(30, 100, 220, ${glowAlpha * 0.5})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, radius * 1.8, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(30, 100, 220, ${glowAlpha})`;
      ctx.fill();
    }

    // --- Selected station glow ---
    if (isSelected) {
      radius = nodeRadius * 1.25;
      ctx.beginPath();
      ctx.arc(x, y, radius * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(200, 160, 0, ${0.2 + pulse * 0.25})`;
      ctx.fill();
    }

    // --- Mr. X last known glow ---
    if (isLastKnown) {
      ctx.beginPath();
      ctx.arc(x, y, radius * 2.2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(200, 160, 0, ${0.1 + pulse * 0.12})`;
      ctx.fill();
    }

    // --- Station shape based on transport type ---
    if (isUnderground) {
      // Diamond shape for underground stations - larger, more prominent
      const r = radius * 1.2;

      // White background behind diamond
      ctx.beginPath();
      ctx.moveTo(x, y - r - 1);
      ctx.lineTo(x + r + 1, y);
      ctx.lineTo(x, y + r + 1);
      ctx.lineTo(x - r - 1, y);
      ctx.closePath();
      ctx.fillStyle = '#fff';
      ctx.fill();

      // Diamond fill
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();

      ctx.fillStyle = isSelected ? '#fff5cc' :
                       isHighlighted ? '#d8e8ff' :
                       '#f8f0f0';
      ctx.fill();

      ctx.strokeStyle = isSelected ? '#cc9900' :
                        isHighlighted ? '#2060cc' :
                        isLastKnown ? '#cc9900' :
                        '#cc2233';
      ctx.lineWidth = isHighlighted || isSelected ? 2.5 : 2;
      if (isLastKnown && !isHighlighted && !isSelected) ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

    } else if (isBus && !isUnderground) {
      // Rounded square for bus stations
      const r = radius * 0.95;
      const cr = r * 0.35;

      // White background
      ctx.beginPath();
      ctx.moveTo(x - r - 1 + cr, y - r - 1);
      ctx.lineTo(x + r + 1 - cr, y - r - 1);
      ctx.arcTo(x + r + 1, y - r - 1, x + r + 1, y - r - 1 + cr, cr);
      ctx.lineTo(x + r + 1, y + r + 1 - cr);
      ctx.arcTo(x + r + 1, y + r + 1, x + r + 1 - cr, y + r + 1, cr);
      ctx.lineTo(x - r - 1 + cr, y + r + 1);
      ctx.arcTo(x - r - 1, y + r + 1, x - r - 1, y + r + 1 - cr, cr);
      ctx.lineTo(x - r - 1, y - r - 1 + cr);
      ctx.arcTo(x - r - 1, y - r - 1, x - r - 1 + cr, y - r - 1, cr);
      ctx.closePath();
      ctx.fillStyle = '#fff';
      ctx.fill();

      // Main shape
      ctx.beginPath();
      ctx.moveTo(x - r + cr, y - r);
      ctx.lineTo(x + r - cr, y - r);
      ctx.arcTo(x + r, y - r, x + r, y - r + cr, cr);
      ctx.lineTo(x + r, y + r - cr);
      ctx.arcTo(x + r, y + r, x + r - cr, y + r, cr);
      ctx.lineTo(x - r + cr, y + r);
      ctx.arcTo(x - r, y + r, x - r, y + r - cr, cr);
      ctx.lineTo(x - r, y - r + cr);
      ctx.arcTo(x - r, y - r, x - r + cr, y - r, cr);
      ctx.closePath();

      ctx.fillStyle = isSelected ? '#fff5cc' :
                       isHighlighted ? '#d8e8ff' :
                       '#f0f8f0';
      ctx.fill();

      ctx.strokeStyle = isSelected ? '#cc9900' :
                        isHighlighted ? '#2060cc' :
                        isLastKnown ? '#cc9900' :
                        '#18874a';
      ctx.lineWidth = isHighlighted || isSelected ? 2 : 1.5;
      if (isLastKnown && !isHighlighted && !isSelected) ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

    } else {
      // Circle for taxi-only stations
      const r = radius * 0.85;

      // White background
      ctx.beginPath();
      ctx.arc(x, y, r + 1, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);

      ctx.fillStyle = isSelected ? '#fff5cc' :
                       isHighlighted ? '#d8e8ff' :
                       '#faf8f0';
      ctx.fill();

      ctx.strokeStyle = isSelected ? '#cc9900' :
                        isHighlighted ? '#2060cc' :
                        isLastKnown ? '#cc9900' :
                        '#8a7a55';
      ctx.lineWidth = isHighlighted || isSelected ? 1.8 : 1;
      if (isLastKnown && !isHighlighted && !isSelected) ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Ferry indicator (small anchor dot)
    if (isFerry) {
      ctx.beginPath();
      ctx.arc(x + radius * 0.55, y - radius * 0.55, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#2a5580';
      ctx.fill();
    }

    // Station number label — always visible
    ctx.fillStyle = isSelected ? '#8a6600' :
                    isHighlighted ? '#1a4488' :
                    isUnderground ? '#882233' :
                    isBus ? '#105530' :
                    '#5a4a30';
    ctx.font = `${isHighlighted || isSelected ? 'bold ' : '600 '}${fontSize}px "Inter", "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(s), x, y);
  }
}

// Avatar shapes for each player type
const AVATAR_SHAPES = {
  don: 'star',      // The Don gets a star
  det1: 'shield',   // Inspector 1 - shield
  det2: 'hexagon',  // Inspector 2 - hexagon
  det3: 'triangle', // Inspector 3 - triangle
  det4: 'pentagon',  // Inspector 4 - pentagon
  det5: 'diamond',  // Inspector 5 - diamond
};

function drawPlayers(ctx, toCanvas, nodeRadius, scale, baseScale) {
  if (!gameState || !gameState.positions) return;

  // Detectives
  for (let i = 0; i < (gameState.detectives || []).length; i++) {
    const detId = gameState.detectives[i];
    const station = gameState.positions[detId];
    if (!station) continue;
    const { x, y } = toCanvas(station);
    const color = DET_COLORS[i % DET_COLORS.length];
    const isCurrentTurn = gameState.currentTurn === detId;
    const shape = ['shield', 'hexagon', 'triangle', 'pentagon', 'diamond'][i % 5];
    const label = 'I' + (i + 1);
    drawToken(ctx, x, y, nodeRadius * 1.5, color, label, isCurrentTurn, scale, shape);
  }

  // The Don — only show if we're The Don, or game is over, or on a reveal round
  const mrXStation = gameState.positions[gameState.mrX];
  if (mrXStation) {
    const { x, y } = toCanvas(mrXStation);
    const isCurrentTurn = gameState.currentTurn === gameState.mrX;
    drawToken(ctx, x, y, nodeRadius * 1.6, MRX_COLOR, 'D', isCurrentTurn, scale, 'star');
  } else if (gameState.mrXLastKnown) {
    // Ghost marker at last known position
    const { x, y } = toCanvas(gameState.mrXLastKnown);
    ctx.globalAlpha = 0.4;
    drawToken(ctx, x, y, nodeRadius * 1.3, MRX_COLOR, 'D?', false, scale, 'star');
    ctx.globalAlpha = 1;
  }
}

function drawToken(ctx, x, y, radius, color, label, isCurrentTurn, scale, shape) {
  // Shadow
  ctx.beginPath();
  ctx.arc(x + 2, y + 3, radius + 1, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fill();

  // Outer ring (glow if current turn)
  if (isCurrentTurn) {
    const pulse = 0.5 + Math.sin(_animFrame * Math.PI * 2) * 0.5;
    ctx.beginPath();
    ctx.arc(x, y, radius * 1.7, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 255, 255, ${0.1 + pulse * 0.15})`;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, radius * 1.35, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.5 + pulse * 0.4})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // White outline for contrast on map
  ctx.save();
  _traceShape(ctx, x, y, radius + 3, shape);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.fill();
  ctx.restore();

  // Main shape with gradient
  const grad = ctx.createRadialGradient(x - radius * 0.25, y - radius * 0.25, radius * 0.1, x, y, radius);
  grad.addColorStop(0, lightenColor(color, 50));
  grad.addColorStop(0.6, color);
  grad.addColorStop(1, darkenColor(color, 50));

  ctx.save();
  _traceShape(ctx, x, y, radius, shape);
  ctx.fillStyle = grad;
  ctx.fill();

  // Border
  ctx.strokeStyle = darkenColor(color, 70);
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.restore();

  // Label
  const fs = Math.max(9, radius * 0.75);
  ctx.fillStyle = label === 'D' || label === 'D?' ? '#000' : '#fff';
  ctx.font = `bold ${fs}px "Inter", "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Text shadow for readability
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 3;
  ctx.fillText(label, x, y);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
}

// Trace different avatar shapes on the canvas context
function _traceShape(ctx, x, y, r, shape) {
  ctx.beginPath();
  switch (shape) {
    case 'star': {
      // 5-point star
      const spikes = 5;
      const outerR = r;
      const innerR = r * 0.5;
      for (let i = 0; i < spikes * 2; i++) {
        const rad = (i * Math.PI / spikes) - Math.PI / 2;
        const rr = i % 2 === 0 ? outerR : innerR;
        const px = x + Math.cos(rad) * rr;
        const py = y + Math.sin(rad) * rr;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'shield': {
      // Shield / badge shape
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.85, y - r * 0.45);
      ctx.lineTo(x + r * 0.7, y + r * 0.3);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r * 0.7, y + r * 0.3);
      ctx.lineTo(x - r * 0.85, y - r * 0.45);
      ctx.closePath();
      break;
    }
    case 'hexagon': {
      for (let i = 0; i < 6; i++) {
        const angle = (i * Math.PI / 3) - Math.PI / 6;
        const px = x + Math.cos(angle) * r;
        const py = y + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'triangle': {
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.87, y + r * 0.5);
      ctx.lineTo(x - r * 0.87, y + r * 0.5);
      ctx.closePath();
      break;
    }
    case 'pentagon': {
      for (let i = 0; i < 5; i++) {
        const angle = (i * 2 * Math.PI / 5) - Math.PI / 2;
        const px = x + Math.cos(angle) * r;
        const py = y + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'diamond': {
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.7, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r * 0.7, y);
      ctx.closePath();
      break;
    }
    default: {
      // Fallback circle
      ctx.arc(x, y, r, 0, Math.PI * 2);
      break;
    }
  }
}

// Color helpers
function lightenColor(hex, amount) {
  const rgb = hexToRgb(hex);
  return `rgb(${Math.min(255, rgb.r + amount)}, ${Math.min(255, rgb.g + amount)}, ${Math.min(255, rgb.b + amount)})`;
}
function darkenColor(hex, amount) {
  const rgb = hexToRgb(hex);
  return `rgb(${Math.max(0, rgb.r - amount)}, ${Math.max(0, rgb.g - amount)}, ${Math.max(0, rgb.b - amount)})`;
}
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return { r: parseInt(h.substring(0, 2), 16), g: parseInt(h.substring(2, 4), 16), b: parseInt(h.substring(4, 6), 16) };
}

// =====================
// HOVER PREVIEW — show reachable stations from any hovered node
// Purely informational, does not interfere with move highlights
// =====================
function drawHoverPreview(ctx, toCanvas, nodeRadius, scale, baseScale) {
  if (!window._adjacency || !hoveredStation) return;
  const s = hoveredStation;
  const from = toCanvas(s);

  // Gather all reachable neighbors by transport type
  const transports = [
    { key: 'taxi',        color: '#e8a800', label: 'A', width: 2.5 },
    { key: 'bus',         color: '#18874a', label: 'B', width: 3 },
    { key: 'underground', color: '#cc2233', label: 'M', width: 4 },
    { key: 'ferry',       color: '#2a5580', label: 'F', width: 3 },
  ];

  const reachable = new Map(); // station -> [{ color, label }]
  for (const t of transports) {
    const adj = window._adjacency[t.key];
    if (!adj || !adj[s]) continue;
    for (const n of adj[s]) {
      if (!reachable.has(n)) reachable.set(n, []);
      reachable.get(n).push(t);
    }
  }

  if (reachable.size === 0) return;

  // Draw highlighted connections from hovered station to each reachable neighbor
  ctx.save();
  for (const [n, types] of reachable) {
    const to = toCanvas(n);
    // Use the highest-priority transport color (last drawn = on top)
    const primary = types[types.length - 1];

    // Glow line
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.strokeStyle = primary.color;
    ctx.lineWidth = (primary.width + 4) * (scale > 0.5 ? 1 : 0.6);
    ctx.globalAlpha = 0.15;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Main line
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.strokeStyle = primary.color;
    ctx.lineWidth = primary.width * (scale > 0.5 ? 1 : 0.6);
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Draw a ring around the hovered station
  ctx.beginPath();
  ctx.arc(from.x, from.y, nodeRadius * 1.8, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.globalAlpha = 0.8;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(from.x, from.y, nodeRadius * 1.8, 0, Math.PI * 2);
  ctx.strokeStyle = '#5080c0';
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.9;
  ctx.stroke();

  // Highlight reachable destination stations with a subtle ring
  for (const [n] of reachable) {
    const to = toCanvas(n);
    ctx.beginPath();
    ctx.arc(to.x, to.y, nodeRadius * 1.4, 0, Math.PI * 2);
    ctx.strokeStyle = '#5080c0';
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.5;
    ctx.stroke();
  }

  ctx.restore();
}

// =====================
// BOARD INTERACTION
// =====================

// Click on board — select a station to move to
canvas.addEventListener('click', (e) => {
  if (isPanning || panMoved) return;
  if (!gameState || gameState.phase !== 'playing') return;
  const isMyTurn = myId && gameState.currentTurn === myId;
  if (!myId || (!isMyTurn && !canControlAI)) return;

  const rect = canvas.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;

  const station = findClosestStation(clickX, clickY);
  if (station && highlightedStations.has(station)) {
    // Find what tickets can reach this station
    const ticketOptions = validMoves.filter(m => m.station === station);
    if (ticketOptions.length === 1) {
      // Auto-select the only option
      socket.emit('move', { destination: station, ticket: ticketOptions[0].ticket });
      selectedStation = null;
    } else if (ticketOptions.length > 1) {
      // Show ticket picker
      selectedStation = station;
      renderActionBar();
      renderBoard();
    }
  }
});

function findClosestStation(cx, cy) {
  if (!stationPositions) return null;

  const container = document.getElementById('board-container');
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  const mapW = 1000, mapH = 700;
  const baseScale = Math.min(cw / mapW, ch / mapH) * 1.08;
  const scale = baseScale * boardZoom;
  const offsetX = cw / 2 + boardPanX;
  const offsetY = ch / 2 + boardPanY;

  let closest = null;
  let closestDist = Infinity;
  const threshold = Math.max(15, 12 * scale / baseScale);

  for (const [s, pos] of Object.entries(stationPositions)) {
    const sx = offsetX + (pos.x - mapW / 2) * scale;
    const sy = offsetY + (pos.y - mapH / 2) * scale;
    const dist = Math.sqrt((cx - sx) ** 2 + (cy - sy) ** 2);
    if (dist < threshold && dist < closestDist) {
      closestDist = dist;
      closest = Number(s);
    }
  }

  return closest;
}

// Pan & Zoom
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  isPanning = true;
  panMoved = false;
  hoveredStation = null; // clear hover during pan
  canvas.style.cursor = '';
  panStart = { x: e.clientX, y: e.clientY };
  panStartOffset = { x: boardPanX, y: boardPanY };
  document.getElementById('board-container').classList.add('grabbing');
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (isPanning) {
    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panMoved = true;
    boardPanX = panStartOffset.x + dx;
    boardPanY = panStartOffset.y + dy;
    renderBoard();
    return;
  }

  // Hover preview — detect station under cursor
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  if (mx < 0 || my < 0 || mx > rect.width || my > rect.height) {
    // Cursor outside canvas
    if (hoveredStation !== null) {
      hoveredStation = null;
      canvas.style.cursor = '';
      renderBoard();
    }
    return;
  }
  const station = findClosestStation(mx, my);
  if (station !== hoveredStation) {
    hoveredStation = station;
    canvas.style.cursor = station ? 'pointer' : '';
    renderBoard();
  }
});

window.addEventListener('mouseup', () => {
  if (!isPanning) return;
  document.getElementById('board-container').classList.remove('grabbing');
  if (panMoved) {
    setTimeout(() => { isPanning = false; panMoved = false; }, 50);
  } else {
    isPanning = false;
  }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.1 : 0.1;
  boardZoom = Math.max(0.3, Math.min(5, boardZoom + delta));
  renderBoard();
}, { passive: false });

// Touch support
let touchStart = null;
let touchStartPan = null;
let lastTouchDist = null;

canvas.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    touchStartPan = { x: boardPanX, y: boardPanY };
  } else if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    lastTouchDist = Math.sqrt(dx * dx + dy * dy);
  }
  e.preventDefault();
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  if (e.touches.length === 1 && touchStart && touchStartPan) {
    boardPanX = touchStartPan.x + (e.touches[0].clientX - touchStart.x);
    boardPanY = touchStartPan.y + (e.touches[0].clientY - touchStart.y);
    renderBoard();
  } else if (e.touches.length === 2 && lastTouchDist) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    boardZoom = Math.max(0.3, Math.min(5, boardZoom * (dist / lastTouchDist)));
    lastTouchDist = dist;
    renderBoard();
  }
  e.preventDefault();
}, { passive: false });

canvas.addEventListener('touchend', () => {
  touchStart = null;
  touchStartPan = null;
  lastTouchDist = null;
});

// Zoom buttons
document.getElementById('btn-zoom-in').addEventListener('click', () => {
  boardZoom = Math.min(5, boardZoom + 0.2);
  renderBoard();
});

document.getElementById('btn-zoom-out').addEventListener('click', () => {
  boardZoom = Math.max(0.3, boardZoom - 0.2);
  renderBoard();
});

document.getElementById('btn-zoom-reset').addEventListener('click', () => {
  boardZoom = 1;
  boardPanX = 0;
  boardPanY = 0;
  renderBoard();
});

// =====================
// SIDEBAR TOGGLE
// =====================
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebar = document.getElementById('sidebar');

if (sidebarToggle && sidebar) {
  sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    sidebarToggle.textContent = sidebar.classList.contains('open') ? '\u2715' : '\u2630';
  });
}

// =====================
// MAP LEGEND TOGGLE
// =====================
const mapLegend = document.querySelector('.map-legend');
if (mapLegend) {
  mapLegend.classList.add('collapsed'); // start collapsed
  mapLegend.addEventListener('click', () => {
    mapLegend.classList.toggle('collapsed');
  });
}

// =====================
// HOW TO PLAY
// =====================
document.getElementById('btn-how-to-play').addEventListener('click', showHowToPlay);

function showHowToPlay() {
  const existing = document.querySelector('.htp-overlay');
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement('div');
  overlay.className = 'htp-overlay';

  const content = document.createElement('div');
  content.className = 'htp-content';
  content.innerHTML = `
    <button class="htp-close" title="Close">&times;</button>
    <h1>How to Play Chennai Galatta</h1>

    <h2>Overview</h2>
    <p><strong>Chennai Galatta</strong> is an asymmetric chase game set across the streets of Chennai.
    One player is <strong>The Don</strong> (the fugitive) and up to 5 players are <strong>Inspectors</strong>
    trying to catch him. The Don moves secretly across a map of 199 stations connected by auto, bus, and metro.</p>

    <h2>Goal</h2>
    <ul>
      <li><strong>Inspectors win</strong> if any inspector moves to The Don's station.</li>
      <li><strong>The Don wins</strong> if he survives all 22 rounds without being caught.</li>
    </ul>

    <h2>The Map</h2>
    <p>The board has 199 numbered stations spread across Chennai, connected by four transport types:</p>
    <ul>
      <li><strong style="color:#e8a800">Auto</strong> (yellow lines) — short range, connects most stations</li>
      <li><strong style="color:#2ecc71">Bus</strong> (green lines) — medium range, fewer stations</li>
      <li><strong style="color:#e63946">Metro</strong> (red lines) — long range, only 16 stations</li>
      <li><strong style="color:#888">Boat</strong> (dashed) — only The Don can use these with a black ticket</li>
    </ul>

    <h2>Turns</h2>
    <p>Each round, <strong>The Don moves first</strong>, then each inspector moves. To move, you
    select a destination station and use a matching ticket.</p>

    <h2>The Don's Secrets</h2>
    <ul>
      <li>The Don's position is <strong>hidden</strong> from inspectors.</li>
      <li>Inspectors can see which <strong>ticket type</strong> The Don used each turn (his travel log).</li>
      <li>The Don's position is <strong>revealed</strong> on rounds <strong>3, 8, 13, 18, and 22</strong>.</li>
    </ul>

    <h2>Special Tickets (The Don only)</h2>
    <ul>
      <li><strong>Black tickets (5)</strong> — hide the transport type used. Also the only way to use boat routes.</li>
      <li><strong>Double move (2)</strong> — take two consecutive moves in one turn.</li>
    </ul>

    <h2>Inspector Tickets</h2>
    <p>Each inspector has limited tickets: <strong>11 auto</strong>, <strong>8 bus</strong>, <strong>4 metro</strong>.
    When you run out, you're stranded at your current station.</p>

    <h2>Tips</h2>
    <ul>
      <li>Inspectors: spread out and gradually tighten the net around The Don.</li>
      <li>Pay attention to The Don's travel log — the ticket types give clues about where he might be.</li>
      <li>The Don: use metro to cover large distances, use black tickets to hide your transport type.</li>
      <li>The Don: save double moves for when inspectors get close.</li>
    </ul>
  `;

  overlay.appendChild(content);
  document.body.appendChild(overlay);

  content.querySelector('.htp-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const histOverlay = document.getElementById('history-overlay');
    if (histOverlay && histOverlay.style.display === 'flex') {
      closeHistoryReview();
      document.getElementById('game-over-overlay').style.display = 'flex';
      e.preventDefault();
      return;
    }
    const htp = document.querySelector('.htp-overlay');
    if (htp) { htp.remove(); e.preventDefault(); return; }
    if (sidebar?.classList.contains('open')) {
      sidebar.classList.remove('open');
      if (sidebarToggle) sidebarToggle.textContent = '\u2630';
      e.preventDefault();
    }
  }
});

// =====================
// HISTORY REVIEW
// =====================
let historyData = null;
let historyStep = 0;
let historyZoom = 1;
let historyPanX = 0;
let historyPanY = 0;
let histIsPanning = false;
let histPanStart = { x: 0, y: 0 };
let histPanStartOffset = { x: 0, y: 0 };
let histPanMoved = false;

document.getElementById('btn-review-game').addEventListener('click', () => {
  if (!gameState || !gameState.history || gameState.history.length === 0) return;
  document.getElementById('game-over-overlay').style.display = 'none';
  openHistoryReview();
});

document.getElementById('btn-history-close').addEventListener('click', closeHistoryReview);
document.getElementById('btn-hist-back').addEventListener('click', () => {
  document.getElementById('history-overlay').style.display = 'none';
  document.getElementById('game-over-overlay').style.display = 'flex';
});

document.getElementById('btn-hist-new-game').addEventListener('click', () => {
  socket.emit('resetGame');
  document.getElementById('history-overlay').style.display = 'none';
  document.getElementById('game-over-overlay').style.display = 'none';
});

document.getElementById('btn-hist-first').addEventListener('click', () => {
  historyStep = 0;
  renderHistoryStep();
});
document.getElementById('btn-hist-prev').addEventListener('click', () => {
  if (historyStep > 0) { historyStep--; renderHistoryStep(); }
});
document.getElementById('btn-hist-next').addEventListener('click', () => {
  if (historyData && historyStep < historyData.length - 1) { historyStep++; renderHistoryStep(); }
});
document.getElementById('btn-hist-last').addEventListener('click', () => {
  if (historyData) { historyStep = historyData.length - 1; renderHistoryStep(); }
});

document.getElementById('hist-round-select').addEventListener('change', (e) => {
  const targetRound = Number(e.target.value);
  // Jump to first snapshot of this round
  if (historyData) {
    const idx = historyData.findIndex(h => h.round === targetRound);
    if (idx >= 0) { historyStep = idx; renderHistoryStep(); }
  }
});

// Keyboard navigation for history
document.addEventListener('keydown', (e) => {
  if (document.getElementById('history-overlay').style.display !== 'flex') return;
  if (e.key === 'ArrowLeft' || e.key === 'a') {
    if (historyStep > 0) { historyStep--; renderHistoryStep(); }
    e.preventDefault();
  } else if (e.key === 'ArrowRight' || e.key === 'd') {
    if (historyData && historyStep < historyData.length - 1) { historyStep++; renderHistoryStep(); }
    e.preventDefault();
  } else if (e.key === 'Home') {
    historyStep = 0; renderHistoryStep(); e.preventDefault();
  } else if (e.key === 'End') {
    if (historyData) { historyStep = historyData.length - 1; renderHistoryStep(); }
    e.preventDefault();
  }
});

function openHistoryReview() {
  historyData = gameState.history;
  historyStep = 0;
  historyZoom = 1;
  historyPanX = 0;
  historyPanY = 0;

  document.getElementById('history-overlay').style.display = 'flex';

  // Populate round select dropdown
  const select = document.getElementById('hist-round-select');
  select.innerHTML = '';
  const rounds = [...new Set(historyData.map(h => h.round))].sort((a, b) => a - b);
  for (const r of rounds) {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = `Round ${r}`;
    select.appendChild(opt);
  }

  // Set up history canvas interaction
  setupHistoryCanvasInteraction();

  // Render first step after a short delay to let DOM layout settle
  setTimeout(() => renderHistoryStep(), 50);
}

function closeHistoryReview() {
  document.getElementById('history-overlay').style.display = 'none';
}

function setupHistoryCanvasInteraction() {
  const hCanvas = document.getElementById('history-canvas');

  // Remove previous listeners if any (re-entry safe)
  hCanvas.onmousedown = (e) => {
    if (e.button !== 0) return;
    histIsPanning = true;
    histPanMoved = false;
    histPanStart = { x: e.clientX, y: e.clientY };
    histPanStartOffset = { x: historyPanX, y: historyPanY };
    hCanvas.style.cursor = 'grabbing';
    e.preventDefault();
  };

  window.addEventListener('mousemove', histMouseMove);
  window.addEventListener('mouseup', histMouseUp);

  hCanvas.onwheel = (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    historyZoom = Math.max(0.3, Math.min(5, historyZoom + delta));
    renderHistoryBoard();
  };
}

function histMouseMove(e) {
  if (!histIsPanning) return;
  const dx = e.clientX - histPanStart.x;
  const dy = e.clientY - histPanStart.y;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) histPanMoved = true;
  historyPanX = histPanStartOffset.x + dx;
  historyPanY = histPanStartOffset.y + dy;
  renderHistoryBoard();
}

function histMouseUp() {
  if (!histIsPanning) return;
  const hCanvas = document.getElementById('history-canvas');
  if (hCanvas) hCanvas.style.cursor = 'grab';
  histIsPanning = false;
  histPanMoved = false;
}

function renderHistoryStep() {
  if (!historyData || historyData.length === 0) return;

  const snap = historyData[historyStep];

  // Update step label
  document.getElementById('hist-step-label').textContent =
    `Step ${historyStep + 1} / ${historyData.length}`;

  // Update round select
  document.getElementById('hist-round-select').value = snap.round;

  // Round info
  document.getElementById('hist-round-info').textContent = `Round ${snap.round}`;

  // Move info
  const moveEl = document.getElementById('hist-move-info');
  if (snap.move && snap.playerName) {
    const roleName = snap.playerRole === 'mrx' ? 'The Don' : 'Inspector';
    const ticketLabel = TICKET_LABELS[snap.move.ticket] || snap.move.ticket;
    moveEl.innerHTML = `<strong>${escapeHTML(snap.playerName)}</strong> (${roleName}) moved to <strong>#${snap.move.destination}</strong> via <span class="ticket-${snap.move.ticket}">${ticketLabel}</span>`;
  } else if (snap.event) {
    moveEl.innerHTML = `<em>${escapeHTML(snap.event)}</em>`;
  } else {
    moveEl.innerHTML = '<em>Starting positions</em>';
  }

  // Event
  const eventEl = document.getElementById('hist-event');
  if (snap.event && snap.move) {
    eventEl.textContent = snap.event;
    eventEl.style.display = '';
  } else {
    eventEl.style.display = 'none';
  }

  // Positions list
  const posEl = document.getElementById('hist-positions');
  posEl.innerHTML = '';
  if (gameState && gameState.turnOrder) {
    for (let i = 0; i < gameState.turnOrder.length; i++) {
      const pid = gameState.turnOrder[i];
      const p = gameState.players[pid];
      if (!p) continue;
      const isMrX = pid === gameState.mrX;
      const color = isMrX ? MRX_COLOR : DET_COLORS[(i - 1) % DET_COLORS.length];
      const station = snap.positions[pid];
      const isActive = snap.playerId === pid;

      const row = document.createElement('div');
      row.className = 'hist-player-row' + (isActive ? ' active' : '');
      row.innerHTML = `
        <span class="player-name">
          <span class="player-dot" style="background:${color}"></span>
          ${escapeHTML(p.name)}
        </span>
        <span class="player-station">#${station || '?'}</span>
      `;
      posEl.appendChild(row);
    }
  }

  // Enable/disable nav buttons
  document.getElementById('btn-hist-first').disabled = historyStep === 0;
  document.getElementById('btn-hist-prev').disabled = historyStep === 0;
  document.getElementById('btn-hist-next').disabled = historyStep >= historyData.length - 1;
  document.getElementById('btn-hist-last').disabled = historyStep >= historyData.length - 1;

  renderHistoryBoard();
}

function renderHistoryBoard() {
  if (!historyData || !stationPositions) return;

  const snap = historyData[historyStep];
  const hCanvas = document.getElementById('history-canvas');
  const container = hCanvas.parentElement;
  const hCtx = hCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  hCanvas.width = container.clientWidth * dpr;
  hCanvas.height = container.clientHeight * dpr;
  hCanvas.style.width = container.clientWidth + 'px';
  hCanvas.style.height = container.clientHeight + 'px';
  hCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const cw = container.clientWidth;
  const ch = container.clientHeight;

  const mapW = 1000, mapH = 700;
  const baseScale = Math.min(cw / mapW, ch / mapH) * 0.92;
  const scale = baseScale * historyZoom;
  const offsetX = cw / 2 + historyPanX;
  const offsetY = ch / 2 + historyPanY;

  function toCanvas(station) {
    const pos = stationPositions[station];
    if (!pos) return { x: 0, y: 0 };
    return {
      x: offsetX + (pos.x - mapW / 2) * scale,
      y: offsetY + (pos.y - mapH / 2) * scale,
    };
  }

  // Background
  hCtx.fillStyle = '#e8dcc0';
  hCtx.fillRect(0, 0, cw, ch);

  // Map SVG background — use labeled version in history (zoom-aware like main board)
  const histUseLabeled = historyZoom >= 1.5 && mapBgLabeledLoaded;
  const histBgImg = histUseLabeled ? mapBgLabeled : (mapBgCleanLoaded ? mapBgClean : null);
  if (histBgImg) {
    const imgX = offsetX - (mapW / 2) * scale;
    const imgY = offsetY - (mapH / 2) * scale;
    const imgW = mapW * scale;
    const imgH = mapH * scale;
    hCtx.drawImage(histBgImg, imgX, imgY, imgW, imgH);
  }

  // Connections
  drawConnections(hCtx, toCanvas, scale, baseScale);

  // Stations (no highlights in history mode)
  const nodeRadius = Math.max(7, 11 * scale / baseScale);
  // Simplified station draw — reuse main function but with no highlights
  const savedHighlighted = highlightedStations;
  const savedSelected = selectedStation;
  const savedGameState = gameState;
  highlightedStations = new Set();
  selectedStation = null;
  // Temporarily set gameState.mrXLastKnown to null so there's no last-known glow
  const savedLastKnown = gameState ? gameState.mrXLastKnown : null;
  if (gameState) gameState.mrXLastKnown = null;

  drawStations(hCtx, toCanvas, nodeRadius, scale, baseScale);

  // Restore
  highlightedStations = savedHighlighted;
  selectedStation = savedSelected;
  if (gameState) gameState.mrXLastKnown = savedLastKnown;

  // Draw players at their history positions
  drawHistoryPlayers(hCtx, toCanvas, nodeRadius, scale, baseScale, snap);

  // If there was a move, draw a movement arrow
  if (snap.move && snap.playerId && historyStep > 0) {
    const prevSnap = historyData[historyStep - 1];
    const prevStation = prevSnap.positions[snap.playerId];
    const newStation = snap.move.destination;
    if (prevStation && newStation && prevStation !== newStation) {
      drawMoveArrow(hCtx, toCanvas, prevStation, newStation, snap.playerRole === 'mrx' ? MRX_COLOR : getDetColor(snap.playerId));
    }
  }
}

function drawHistoryPlayers(ctx, toCanvas, nodeRadius, scale, baseScale, snap) {
  if (!gameState || !snap.positions) return;

  // Detectives
  for (let i = 0; i < (gameState.detectives || []).length; i++) {
    const detId = gameState.detectives[i];
    const station = snap.positions[detId];
    if (!station) continue;
    const { x, y } = toCanvas(station);
    const color = DET_COLORS[i % DET_COLORS.length];
    const isActive = snap.playerId === detId;
    const shape = ['shield', 'hexagon', 'triangle', 'pentagon', 'diamond'][i % 5];
    const label = 'I' + (i + 1);
    drawToken(ctx, x, y, nodeRadius * 1.5, color, label, isActive, scale, shape);
  }

  // The Don — always visible in history review
  const mrXStation = snap.positions[gameState.mrX];
  if (mrXStation) {
    const { x, y } = toCanvas(mrXStation);
    const isActive = snap.playerId === gameState.mrX;
    drawToken(ctx, x, y, nodeRadius * 1.6, MRX_COLOR, 'D', isActive, scale, 'star');
  }
}

function getDetColor(playerId) {
  if (!gameState) return DET_COLORS[0];
  const idx = (gameState.detectives || []).indexOf(playerId);
  return idx >= 0 ? DET_COLORS[idx % DET_COLORS.length] : DET_COLORS[0];
}

function drawMoveArrow(ctx, toCanvas, fromStation, toStation, color) {
  const from = toCanvas(fromStation);
  const to = toCanvas(toStation);

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;

  // Shorten the arrow slightly so it doesn't overlap tokens
  const shorten = 15;
  const fx = from.x + (dx / len) * shorten;
  const fy = from.y + (dy / len) * shorten;
  const tx = to.x - (dx / len) * shorten;
  const ty = to.y - (dy / len) * shorten;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.globalAlpha = 0.6;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(fx, fy);
  ctx.lineTo(tx, ty);
  ctx.stroke();
  ctx.setLineDash([]);

  // Arrowhead
  const angle = Math.atan2(ty - fy, tx - fx);
  const headLen = 10;
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx - headLen * Math.cos(angle - 0.4), ty - headLen * Math.sin(angle - 0.4));
  ctx.lineTo(tx - headLen * Math.cos(angle + 0.4), ty - headLen * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.7;
  ctx.fill();
  ctx.restore();
}

// Handle history overlay resize
window.addEventListener('resize', () => {
  if (document.getElementById('history-overlay').style.display === 'flex') {
    renderHistoryBoard();
  }
});

// =====================
// RESIZE
// =====================
window.addEventListener('resize', () => {
  if (gameState) renderBoard();
});

// =====================
// HELPERS
// =====================
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// =====================
// ADJACENCY DATA
// =====================
// We need the full adjacency on the client for drawing connections
// Request it from the server when we connect
socket.on('adjacency', (data) => {
  window._adjacency = data;

  // Build station type sets for rendering
  undergroundStations = new Set();
  busStations = new Set();
  ferryStations = new Set();
  if (data.underground) {
    for (const s of Object.keys(data.underground)) undergroundStations.add(Number(s));
  }
  if (data.bus) {
    for (const s of Object.keys(data.bus)) busStations.add(Number(s));
  }
  if (data.ferry) {
    for (const s of Object.keys(data.ferry)) ferryStations.add(Number(s));
  }

  if (gameState) renderBoard();
});

socket.emit('getAdjacency');
