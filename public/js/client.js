// Scotland Yard — Client
const socket = io();

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

// Detective colors
const DET_COLORS = ['#e63946', '#457b9d', '#2ecc71', '#9b5de5', '#f77f00'];
const MRX_COLOR = '#ffd700';

const TICKET_COLORS = {
  taxi: '#f1c40f',
  bus: '#2ecc71',
  underground: '#e63946',
  black: '#888',
};

const TICKET_LABELS = {
  taxi: 'Taxi',
  bus: 'Bus',
  underground: 'Tube',
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
  socket.emit('join', { name, role });
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

document.getElementById('btn-new-game').addEventListener('click', () => {
  socket.emit('resetGame');
  document.getElementById('game-over-overlay').style.display = 'none';
});

socket.on('lobbyState', (lobby) => {
  showScreen('lobby-screen');
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
        <span class="lobby-player-role ${p.role}">${p.role === 'mrx' ? 'Mr. X' : 'Detective'}</span>
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

  // Request valid moves if it's my turn
  if (myId && state.currentTurn === myId && state.phase === 'playing') {
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

  // Turn info
  const currentPlayer = gameState.players[gameState.currentTurn];
  const isMyTurn = myId && gameState.currentTurn === myId;

  if (gameState.phase === 'ended') {
    document.getElementById('turn-info').textContent = 'Game Over';
    document.getElementById('turn-info').style.color = 'var(--gold)';
  } else if (isMyTurn) {
    document.getElementById('turn-info').textContent = 'Your turn!';
    document.getElementById('turn-info').style.color = 'var(--gold)';
  } else if (currentPlayer) {
    document.getElementById('turn-info').textContent = `${currentPlayer.name}'s turn`;
    document.getElementById('turn-info').style.color = 'var(--text)';
  }

  // Double move indicator
  if (gameState.isDoubleMoveFirstHalf) {
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
    role === 'mrx' ? 'Mr. X' : 'Detective';

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
    const color = isMrX ? MRX_COLOR : DET_COLORS[(i - 1) % DET_COLORS.length];

    const row = document.createElement('div');
    row.className = 'player-row' +
      (isCurrentTurn ? ' active-turn' : '') +
      (p.stranded ? ' stranded' : '');

    const station = gameState.positions[pid];
    const stationText = station ? `#${station}` : (isMrX ? '?' : '');

    row.innerHTML = `
      <span class="player-name">
        <span class="player-dot" style="background:${color}"></span>
        ${escapeHTML(p.name)}${pid === myId ? ' (You)' : ''}
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
  if (!myId || gameState.currentTurn !== myId) {
    container.innerHTML = '<span class="action-label">Waiting for other players...</span>';
    return;
  }

  const isMrX = myId === gameState.mrX;

  // Double move button for Mr. X
  if (isMrX && !gameState.isDoubleMoveFirstHalf) {
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
    gameState.winner === 'mrx' ? 'Mr. X Wins!' : 'Detectives Win!';
  document.getElementById('game-over-reason').textContent = gameState.winReason || '';
}

// =====================
// BOARD RENDERING
// =====================
const canvas = document.getElementById('board-canvas');
const ctx = canvas.getContext('2d');

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
  ctx.clearRect(0, 0, cw, ch);

  // Compute scale to fit the 1000x700 map into the canvas
  const mapW = 1000, mapH = 700;
  const baseScale = Math.min(cw / mapW, ch / mapH) * 0.92;
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

  function fromCanvas(cx, cy) {
    return {
      x: (cx - offsetX) / scale + mapW / 2,
      y: (cy - offsetY) / scale + mapH / 2,
    };
  }

  // Draw connections
  const ADJ_DATA = buildAdjacencyFromPositions();
  drawConnections(ctx, toCanvas, scale, ADJ_DATA);

  // Draw stations
  const nodeRadius = Math.max(6, 10 * scale / baseScale);
  const allStations = Object.keys(stationPositions).map(Number);

  for (const s of allStations) {
    const { x, y } = toCanvas(s);

    // Determine color
    let fillColor = '#1a1a2e';
    let strokeColor = '#3a3a5a';
    let radius = nodeRadius;
    let label = String(s);

    // Highlighted (valid move destination)
    if (highlightedStations.has(s)) {
      fillColor = 'rgba(74, 158, 255, 0.3)';
      strokeColor = '#4a9eff';
      radius = nodeRadius * 1.2;
    }

    // Selected station
    if (s === selectedStation) {
      fillColor = 'rgba(255, 215, 0, 0.4)';
      strokeColor = '#ffd700';
      radius = nodeRadius * 1.3;
    }

    // Mr. X last known
    if (gameState && s === gameState.mrXLastKnown) {
      strokeColor = MRX_COLOR;
      ctx.setLineDash([3, 3]);
    }

    // Draw node
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);

    // Station number
    const fontSize = Math.max(6, 8 * scale / baseScale);
    ctx.fillStyle = '#8899aa';
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y);
  }

  // Draw player tokens
  if (gameState && gameState.positions) {
    // Detectives
    for (let i = 0; i < (gameState.detectives || []).length; i++) {
      const detId = gameState.detectives[i];
      const station = gameState.positions[detId];
      if (!station) continue;
      const { x, y } = toCanvas(station);
      const color = DET_COLORS[i % DET_COLORS.length];
      drawToken(ctx, x, y, nodeRadius * 1.4, color, 'D' + (i + 1));
    }

    // Mr. X — only show if we're Mr. X, or game is over, or on a reveal round
    const mrXStation = gameState.positions[gameState.mrX];
    if (mrXStation) {
      const { x, y } = toCanvas(mrXStation);
      drawToken(ctx, x, y, nodeRadius * 1.5, MRX_COLOR, 'X');
    } else if (gameState.mrXLastKnown) {
      // Show last known with a ghost marker
      const { x, y } = toCanvas(gameState.mrXLastKnown);
      ctx.globalAlpha = 0.4;
      drawToken(ctx, x, y, nodeRadius * 1.3, MRX_COLOR, 'X?');
      ctx.globalAlpha = 1;
    }
  }
}

function drawToken(ctx, x, y, radius, color, label) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#000';
  ctx.font = `bold ${Math.max(8, radius * 0.8)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y);
}

// Build adjacency data for drawing connections
// We cache this since it doesn't change
let _adjCache = null;
function buildAdjacencyFromPositions() {
  if (_adjCache) return _adjCache;
  // We'll fetch adjacency from the server implicitly through game mechanics
  // For rendering, we parse the connections from known transport data
  // Since we don't have the adjacency on the client, we'll build it from the server state
  // Actually, we need to ship adjacency to the client for rendering connections
  // For now, return empty — connections will be drawn once we get the data
  return null;
}

function drawConnections(ctx, toCanvas, scale, adjData) {
  // We need adjacency data on the client to draw connections
  // This will be populated once we receive it from the server
  if (!window._adjacency) return;

  const drawn = new Set();

  for (const [type, adj, color, width] of [
    ['underground', window._adjacency.underground, '#e63946', 3],
    ['bus', window._adjacency.bus, '#2ecc71', 2],
    ['taxi', window._adjacency.taxi, '#f1c40f', 0.8],
    ['ferry', window._adjacency.ferry, '#888', 2],
  ]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width * (scale > 0.5 ? 1 : 0.5);
    ctx.globalAlpha = type === 'taxi' ? 0.25 : 0.5;

    if (type === 'ferry') {
      ctx.setLineDash([5, 5]);
    }

    for (const [s, neighbors] of Object.entries(adj)) {
      for (const n of neighbors) {
        const key = `${type}-${Math.min(s, n)}-${Math.max(s, n)}`;
        if (drawn.has(key)) continue;
        drawn.add(key);

        const from = toCanvas(Number(s));
        const to = toCanvas(Number(n));
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }
    }

    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
}

// =====================
// BOARD INTERACTION
// =====================

// Click on board — select a station to move to
canvas.addEventListener('click', (e) => {
  if (isPanning || panMoved) return;
  if (!gameState || gameState.phase !== 'playing') return;
  if (!myId || gameState.currentTurn !== myId) return;

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
  const baseScale = Math.min(cw / mapW, ch / mapH) * 0.92;
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
  panStart = { x: e.clientX, y: e.clientY };
  panStartOffset = { x: boardPanX, y: boardPanY };
  document.getElementById('board-container').classList.add('grabbing');
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!isPanning) return;
  const dx = e.clientX - panStart.x;
  const dy = e.clientY - panStart.y;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panMoved = true;
  boardPanX = panStartOffset.x + dx;
  boardPanY = panStartOffset.y + dy;
  renderBoard();
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
    <h1>How to Play Scotland Yard</h1>

    <h2>Overview</h2>
    <p><strong>Scotland Yard</strong> is an asymmetric game of cat and mouse set in London.
    One player is <strong>Mr. X</strong> (the fugitive) and up to 5 players are <strong>detectives</strong>
    trying to catch him. Mr. X moves secretly across a map of 199 stations connected by taxi, bus, and underground.</p>

    <h2>Goal</h2>
    <ul>
      <li><strong>Detectives win</strong> if any detective moves to Mr. X's station.</li>
      <li><strong>Mr. X wins</strong> if he survives all 22 rounds without being caught.</li>
    </ul>

    <h2>The Map</h2>
    <p>The board has 199 numbered stations connected by three transport types:</p>
    <ul>
      <li><strong style="color:#f1c40f">Taxi</strong> (yellow lines) — short range, connects most stations</li>
      <li><strong style="color:#2ecc71">Bus</strong> (green lines) — medium range, fewer stations</li>
      <li><strong style="color:#e63946">Underground</strong> (red lines) — long range, only 16 stations</li>
      <li><strong style="color:#888">Ferry</strong> (dashed) — only Mr. X can use these with a black ticket</li>
    </ul>

    <h2>Turns</h2>
    <p>Each round, <strong>Mr. X moves first</strong>, then each detective moves. To move, you
    select a destination station and use a matching ticket.</p>

    <h2>Mr. X's Secrets</h2>
    <ul>
      <li>Mr. X's position is <strong>hidden</strong> from detectives.</li>
      <li>Detectives can see which <strong>ticket type</strong> Mr. X used each turn (his travel log).</li>
      <li>Mr. X's position is <strong>revealed</strong> on rounds <strong>3, 8, 13, 18, and 22</strong>.</li>
    </ul>

    <h2>Special Tickets (Mr. X only)</h2>
    <ul>
      <li><strong>Black tickets (5)</strong> — hide the transport type used. Also the only way to use ferry routes.</li>
      <li><strong>Double move (2)</strong> — take two consecutive moves in one turn.</li>
    </ul>

    <h2>Detective Tickets</h2>
    <p>Each detective has limited tickets: <strong>11 taxi</strong>, <strong>8 bus</strong>, <strong>4 underground</strong>.
    When you run out, you're stranded at your current station.</p>

    <h2>Tips</h2>
    <ul>
      <li>Detectives: spread out and gradually tighten the net around Mr. X.</li>
      <li>Pay attention to Mr. X's travel log — the ticket types give clues about where he might be.</li>
      <li>Mr. X: use underground to cover large distances, use black tickets to hide your transport type.</li>
      <li>Mr. X: save double moves for when detectives get close.</li>
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
  if (gameState) renderBoard();
});

socket.emit('getAdjacency');
