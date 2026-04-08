// Scotland Yard — Server
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

const game = new GameState();

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
  while (game.phase === 'playing' && game.currentTurn && game.players[game.currentTurn]?.isAI) {
    await new Promise(r => setTimeout(r, AI_DELAY));

    const aiId = game.currentTurn;
    const isMrX = aiId === game.mrX;

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
  socket.on('join', ({ name, role }) => {
    if (!name || !role) {
      socket.emit('error', { message: 'Name and role required' });
      return;
    }

    const result = game.addPlayer(socket.id, name.trim().substring(0, 20), role);
    if (result.error) {
      socket.emit('error', { message: result.error });
      return;
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
    if (game.currentTurn !== playerId) {
      socket.emit('error', { message: 'Not your turn' });
      return;
    }

    const result = game.makeMove(playerId, destination, ticket);
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
    if (!playerId || game.currentTurn !== playerId) {
      if (typeof callback === 'function') callback([]);
      return;
    }
    const moves = game.getValidMoves(playerId);
    if (typeof callback === 'function') callback(moves);
  });

  // Reset game
  socket.on('resetGame', () => {
    game.reset();
    console.log('Game reset');
    broadcastLobby();
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
    // If in lobby, remove player
    if (game.phase === 'lobby') {
      game.removePlayer(socket.id);
      broadcastLobby();
    }
    // If in game, mark player as disconnected (AI takes over)
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  Scotland Yard Online`);
  console.log(`  Server running on http://localhost:${PORT}`);
  console.log(`  Waiting for players...\n`);
});
