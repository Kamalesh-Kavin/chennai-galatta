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

// Pre-built sets for station types (populated when adjacency arrives)
let undergroundStations = new Set();
let busStations = new Set();
let ferryStations = new Set();

// Load SVG map background as an image
let mapBgImage = null;
let mapBgLoaded = false;
const mapBgImg = new Image();
mapBgImg.onload = () => { mapBgLoaded = true; mapBgImage = mapBgImg; renderBoard(); };
mapBgImg.src = '/img/london-map.svg';

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

  // === BACKGROUND ===
  // Fill with a neutral matching color first
  ctx.fillStyle = '#d8ccb8';
  ctx.fillRect(0, 0, cw, ch);

  // Draw the SVG map image, aligned to the station coordinate system
  if (mapBgLoaded && mapBgImage) {
    const imgX = offsetX - (mapW / 2) * scale;
    const imgY = offsetY - (mapH / 2) * scale;
    const imgW = mapW * scale;
    const imgH = mapH * scale;
    ctx.drawImage(mapBgImage, imgX, imgY, imgW, imgH);
  }

  // === CONNECTIONS ===
  drawConnections(ctx, toCanvas, scale, baseScale);

  // === STATIONS ===
  const nodeRadius = Math.max(7, 11 * scale / baseScale);
  drawStations(ctx, toCanvas, nodeRadius, scale, baseScale);

  // === PLAYER TOKENS ===
  drawPlayers(ctx, toCanvas, nodeRadius, scale, baseScale);

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
    { type: 'taxi',        adj: window._adjacency.taxi,        color: '#c8a000', width: 1.5, alpha: 0.6,  dash: null },
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
  const fontSize = Math.max(5, 7.5 * scale / baseScale);
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

    // Station number label
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
    drawToken(ctx, x, y, nodeRadius * 1.5, color, 'D' + (i + 1), isCurrentTurn, scale);
  }

  // Mr. X — only show if we're Mr. X, or game is over, or on a reveal round
  const mrXStation = gameState.positions[gameState.mrX];
  if (mrXStation) {
    const { x, y } = toCanvas(mrXStation);
    const isCurrentTurn = gameState.currentTurn === gameState.mrX;
    drawToken(ctx, x, y, nodeRadius * 1.6, MRX_COLOR, 'X', isCurrentTurn, scale);
  } else if (gameState.mrXLastKnown) {
    // Ghost marker at last known position
    const { x, y } = toCanvas(gameState.mrXLastKnown);
    ctx.globalAlpha = 0.4;
    drawToken(ctx, x, y, nodeRadius * 1.3, MRX_COLOR, 'X?', false, scale);
    ctx.globalAlpha = 1;
  }
}

function drawToken(ctx, x, y, radius, color, label, isCurrentTurn, scale) {
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
  ctx.beginPath();
  ctx.arc(x, y, radius + 2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.fill();

  // Main circle with gradient
  const grad = ctx.createRadialGradient(x - radius * 0.25, y - radius * 0.25, radius * 0.1, x, y, radius);
  grad.addColorStop(0, lightenColor(color, 50));
  grad.addColorStop(0.6, color);
  grad.addColorStop(1, darkenColor(color, 50));

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // Border
  ctx.strokeStyle = darkenColor(color, 70);
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Inner highlight arc (top-left shine)
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.65, Math.PI * 1.15, Math.PI * 1.85);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Label
  const fs = Math.max(9, radius * 0.8);
  ctx.fillStyle = label === 'X' || label === 'X?' ? '#000' : '#fff';
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
