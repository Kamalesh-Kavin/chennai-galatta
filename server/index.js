// Chennai Galatta — Server
// Express + Socket.IO, single game room

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const GameState = require('./game/GameState');
const AI = require('./game/AI');
const { STATION_POSITIONS, TAXI, BUS, UNDERGROUND, FERRY } = require('./data/map');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '..', 'public')));

// Health / keep-alive endpoint (prevents Render free-tier idle timeout)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', phase: game.phase, uptime: process.uptime() | 0 });
});

const game = new GameState();

// Session-to-player mapping for reconnection
// Maps sessionId (client-generated UUID) -> playerId in the game
const sessionMap = {};  // sessionId -> playerId

// AI move delay (ms) for realism
const AI_DELAY = 800;

// =====================
// HELPERS
// =====================

function broadcastState() {
  for (const [id, player] of Object.entries(game.players)) {
    if (!player.isAI && player.socketId) {
      const state = game.getStateForPlayer(id);
      state.myId = id;
      state.stationPositions = STATION_POSITIONS;
      io.to(player.socketId).emit('gameState', state);
    }
  }
  // Also broadcast to spectators (sockets not in the game)
  const playerSockets = new Set(
    Object.values(game.players).filter(p => !p.isAI && p.socketId).map(p => p.socketId)
  );
  for (const [socketId, socket] of io.sockets.sockets) {
    if (!playerSockets.has(socketId)) {
      const state = game.getDetectiveView();
      state.myId = null;
      state.stationPositions = STATION_POSITIONS;
      socket.emit('gameState', state);
    }
  }
}

function broadcastLobby() {
  const lobby = {
    phase: game.phase,
    players: {},
    mrX: game.mrX,
    detectives: game.detectives,
  };
  for (const [id, p] of Object.entries(game.players)) {
    lobby.players[id] = { name: p.name, role: p.role, isAI: p.isAI };
  }
  io.emit('lobbyState', lobby);
}

async function processAITurns() {
  while (game.phase === 'playing' && !game.paused && game.currentTurn && game.players[game.currentTurn]?.isAI) {
    const aiId = game.currentTurn;
    const isMrX = aiId === game.mrX;

    // If human-controlled AI mode is active, skip auto-play for AI inspectors
    // (humans will submit moves on their behalf)
    if (game.humanControlledAI && !isMrX) {
      broadcastState();
      break;
    }

    await new Promise(r => setTimeout(r, AI_DELAY));

    // Re-check pause state after delay (could have been paused while waiting)
    if (game.paused || game.phase !== 'playing') break;

    // Check if Mr. X AI should use double move
    if (isMrX && !game.isDoubleMoveFirstHalf && AI.shouldUseDoubleMove(game)) {
      const result = game.useDoubleMove(aiId);
      if (result.ok) {
        broadcastState();
        await new Promise(r => setTimeout(r, AI_DELAY / 2));
      }
    }

    const move = AI.getMove(game, aiId);
    if (!move) {
      // Stranded — advance turn
      game.players[aiId].stranded = true;
      game._advanceTurn();
      broadcastState();
      continue;
    }

    const result = game.makeMove(aiId, move.station, move.ticket);
    broadcastState();

    if (result.gameOver) break;
  }
}

// =====================
// SOCKET EVENTS
// =====================

io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  // Send adjacency data for board rendering
  socket.emit('adjacency', { taxi: TAXI, bus: BUS, underground: UNDERGROUND, ferry: FERRY });

  socket.on('getAdjacency', () => {
    socket.emit('adjacency', { taxi: TAXI, bus: BUS, underground: UNDERGROUND, ferry: FERRY });
  });

  // Attempt auto-rejoin: client sends sessionId, server checks if it maps to a DC'd player
  socket.on('rejoin', ({ sessionId }) => {
    if (!sessionId || game.phase !== 'playing') {
      socket.emit('rejoinResult', { ok: false });
      return;
    }

    const playerId = sessionMap[sessionId];
    if (!playerId || !game.players[playerId]) {
      socket.emit('rejoinResult', { ok: false });
      return;
    }

    const player = game.players[playerId];

    // Only rejoin if the player is currently disconnected (AI takeover)
    if (player.socketId && player.socketId !== socket.id) {
      // Player is still connected on another socket — don't hijack
      socket.emit('rejoinResult', { ok: false });
      return;
    }

    // Reclaim the slot
    player.socketId = socket.id;
    player.isAI = false;
    // Remove " (DC)" suffix if present
    player.name = player.name.replace(/\s*\(DC\)$/, '');

    console.log(`${player.name} reconnected as ${player.role}`);

    // Send them their state
    const state = game.getStateForPlayer(playerId);
    state.myId = playerId;
    state.stationPositions = STATION_POSITIONS;
    socket.emit('rejoinResult', { ok: true, playerId });
    socket.emit('gameState', state);

    // Broadcast updated state to everyone
    broadcastState();

    // If it was this player's turn but AI hadn't moved yet, they can move now
    // (no need to call processAITurns — player is human again)
  });

  // Send current state
  if (game.phase === 'lobby') {
    broadcastLobby();
  } else {
    const state = game.getDetectiveView();
    state.myId = null;
    state.stationPositions = STATION_POSITIONS;
    socket.emit('gameState', state);
  }

  // Join game
  socket.on('join', ({ name, role, sessionId }) => {
    if (!name || !role) {
      socket.emit('error', { message: 'Name and role required' });
      return;
    }

    const result = game.addPlayer(socket.id, name.trim().substring(0, 20), role);
    if (result.error) {
      socket.emit('error', { message: result.error });
      return;
    }

    // Track session for reconnection
    if (sessionId) {
      sessionMap[sessionId] = socket.id;  // playerId === socket.id in lobby
    }

    console.log(`${name} joined as ${role}`);
    broadcastLobby();
  });

  // Leave game (lobby only)
  socket.on('leave', () => {
    game.removePlayer(socket.id);
    broadcastLobby();
  });

  // Start game
  socket.on('startGame', () => {
    if (game.phase !== 'lobby') return;
    // Must have at least 1 player
    const humanCount = Object.values(game.players).filter(p => !p.isAI).length;
    if (humanCount === 0) {
      socket.emit('error', { message: 'At least one human player required' });
      return;
    }

    const result = game.startGame();
    if (result.error) {
      socket.emit('error', { message: result.error });
      return;
    }

    console.log('Game started!');
    broadcastState();

    // Process AI turns if Mr. X is AI
    processAITurns();
  });

  // Make move
  socket.on('move', ({ destination, ticket }) => {
    if (game.phase !== 'playing') return;

    // Find player by socket
    const playerId = Object.keys(game.players).find(
      id => game.players[id].socketId === socket.id
    );
    if (!playerId) return;

    // Determine who the move is for
    let moveForId = playerId;

    if (game.currentTurn !== playerId) {
      // Allow human inspectors to control AI inspectors when humanControlledAI is active
      const currentTurnPlayer = game.players[game.currentTurn];
      const submitter = game.players[playerId];
      if (
        game.humanControlledAI &&
        currentTurnPlayer?.isAI &&
        currentTurnPlayer?.role === 'detective' &&
        submitter?.role === 'detective' &&
        !submitter?.isAI
      ) {
        moveForId = game.currentTurn; // submit move on behalf of the AI
      } else {
        socket.emit('error', { message: 'Not your turn' });
        return;
      }
    }

    const result = game.makeMove(moveForId, destination, ticket);
    if (result.error) {
      socket.emit('error', { message: result.error });
      return;
    }

    broadcastState();

    if (!result.gameOver) {
      processAITurns();
    }
  });

  // Use double move (Mr. X only)
  socket.on('useDoubleMove', () => {
    const playerId = Object.keys(game.players).find(
      id => game.players[id].socketId === socket.id
    );
    if (!playerId) return;

    const result = game.useDoubleMove(playerId);
    if (result.error) {
      socket.emit('error', { message: result.error });
      return;
    }

    broadcastState();
  });

  // Get valid moves
  socket.on('getValidMoves', (_, callback) => {
    const playerId = Object.keys(game.players).find(
      id => game.players[id].socketId === socket.id
    );
    if (!playerId) {
      if (typeof callback === 'function') callback([]);
      return;
    }

    // If it's the requester's turn, return their moves
    if (game.currentTurn === playerId) {
      const moves = game.getValidMoves(playerId);
      if (typeof callback === 'function') callback(moves);
      return;
    }

    // If humanControlledAI: allow human inspectors to get AI inspector's valid moves
    const currentTurnPlayer = game.players[game.currentTurn];
    const submitter = game.players[playerId];
    if (
      game.humanControlledAI &&
      currentTurnPlayer?.isAI &&
      currentTurnPlayer?.role === 'detective' &&
      submitter?.role === 'detective' &&
      !submitter?.isAI
    ) {
      const moves = game.getValidMoves(game.currentTurn);
      if (typeof callback === 'function') callback(moves);
      return;
    }

    if (typeof callback === 'function') callback([]);
  });

  // Reset game
  socket.on('resetGame', () => {
    game.reset();
    // Clear all session mappings
    for (const key of Object.keys(sessionMap)) delete sessionMap[key];
    console.log('Game reset');
    broadcastLobby();
  });

  // Pause / Resume game
  socket.on('togglePause', () => {
    const result = game.togglePause();
    if (result.error) {
      socket.emit('error', { message: result.error });
      return;
    }
    console.log(result.paused ? 'Game paused' : 'Game resumed');
    broadcastState();

    // If resumed and it's an AI's turn, resume AI processing
    if (!result.paused) {
      processAITurns();
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
    // If in lobby, remove player and clean up session mapping
    if (game.phase === 'lobby') {
      game.removePlayer(socket.id);
      // Remove session mapping for this player
      for (const [sid, pid] of Object.entries(sessionMap)) {
        if (pid === socket.id) delete sessionMap[sid];
      }
      broadcastLobby();
    }
    // If in game, mark player as disconnected (AI takes over)
    // Session mapping is preserved so they can rejoin
    if (game.phase === 'playing') {
      const playerId = Object.keys(game.players).find(
        id => game.players[id].socketId === socket.id
      );
      if (playerId) {
        game.players[playerId].isAI = true;
        game.players[playerId].socketId = null;
        game.players[playerId].name += ' (DC)';
        console.log(`${game.players[playerId].name} disconnected — AI takes over`);
        broadcastState();
        // If it was their turn, process AI
        if (game.currentTurn === playerId) {
          processAITurns();
        }
      }
    }
  });
});

// =====================
// START
// =====================

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n  Chennai Galatta`);
  console.log(`  Server running on http://localhost:${PORT}`);
  console.log(`  Waiting for players...\n`);
});
