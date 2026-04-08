// Scotland Yard — Game State Engine
// Server-authoritative game logic

const { TAXI, BUS, UNDERGROUND, FERRY, START_POSITIONS, REVEAL_ROUNDS, MAX_ROUNDS, STATION_POSITIONS } = require('../data/map');

const DETECTIVE_TICKETS = { taxi: 11, bus: 8, underground: 4 };
const MRX_BLACK_TICKETS = 5;
const MRX_DOUBLE_MOVES = 2;

class GameState {
  constructor() {
    this.reset();
  }

  reset() {
    this.phase = 'lobby'; // lobby | playing | ended
    this.players = {};     // id -> { name, role, socketId, isAI, ... }
    this.mrX = null;       // player id of Mr. X
    this.detectives = [];  // player ids of detectives (up to 5)
    this.round = 0;
    this.currentTurn = null; // player id whose turn it is
    this.turnOrder = [];     // [mrX, det1, det2, ...] — mrX always first
    this.turnIndex = 0;
    this.winner = null;      // 'mrx' | 'detectives' | null
    this.winReason = '';

    // Mr. X travel log: [{round, ticket, station (hidden), revealed}]
    this.travelLog = [];

    // Mr. X double move state
    this.isDoubleMoveFirstHalf = false;

    // Positions
    this.positions = {};   // playerId -> station number
    this.mrXLastKnown = null; // last revealed station

    // Tickets
    this.tickets = {};     // playerId -> { taxi, bus, underground, black, doubleMoves }

    // Used starting positions
    this.usedStarts = new Set();
  }

  // =====================
  // LOBBY
  // =====================

  addPlayer(id, name, role, isAI = false) {
    if (this.phase !== 'lobby') return { error: 'Game already in progress' };

    // Validate role
    if (role === 'mrx') {
      if (this.mrX) return { error: 'Mr. X role is already taken' };
    } else if (role === 'detective') {
      if (this.detectives.length >= 5) return { error: 'All detective slots are full' };
    } else {
      return { error: 'Invalid role. Choose mrx or detective.' };
    }

    this.players[id] = {
      name,
      role,
      isAI,
      socketId: isAI ? null : id,
      stranded: false,
    };

    if (role === 'mrx') {
      this.mrX = id;
    } else {
      this.detectives.push(id);
    }

    return { ok: true };
  }

  removePlayer(id) {
    if (!this.players[id]) return;
    const p = this.players[id];
    if (p.role === 'mrx') this.mrX = null;
    else this.detectives = this.detectives.filter(d => d !== id);
    delete this.players[id];
  }

  // Fill empty slots with AI
  fillWithAI() {
    if (!this.mrX) {
      const id = 'ai_mrx';
      this.addPlayer(id, 'Mr. X (AI)', 'mrx', true);
    }
    while (this.detectives.length < 5) {
      const id = `ai_det_${this.detectives.length + 1}`;
      const num = this.detectives.length + 1;
      this.addPlayer(id, `Detective ${num} (AI)`, 'detective', true);
    }
  }

  // =====================
  // START GAME
  // =====================

  startGame() {
    if (this.phase !== 'lobby') return { error: 'Game already started' };

    // Fill remaining slots with AI before validation
    this.fillWithAI();

    if (!this.mrX) return { error: 'No Mr. X player' };
    if (this.detectives.length === 0) return { error: 'No detectives' };

    this.phase = 'playing';
    this.round = 1;

    // Assign starting positions
    const shuffled = [...START_POSITIONS].sort(() => Math.random() - 0.5);
    let posIdx = 0;

    // Mr. X gets first position
    this.positions[this.mrX] = shuffled[posIdx++];
    this.usedStarts.add(this.positions[this.mrX]);

    // Detectives get remaining positions
    for (const detId of this.detectives) {
      this.positions[detId] = shuffled[posIdx++];
      this.usedStarts.add(this.positions[detId]);
    }

    // Assign tickets
    this.tickets[this.mrX] = {
      taxi: 99, bus: 99, underground: 99, // effectively unlimited
      black: MRX_BLACK_TICKETS,
      doubleMoves: MRX_DOUBLE_MOVES,
    };

    for (const detId of this.detectives) {
      this.tickets[detId] = {
        taxi: DETECTIVE_TICKETS.taxi,
        bus: DETECTIVE_TICKETS.bus,
        underground: DETECTIVE_TICKETS.underground,
        black: 0,
        doubleMoves: 0,
      };
    }

    // Turn order: Mr. X first, then detectives
    this.turnOrder = [this.mrX, ...this.detectives];
    this.turnIndex = 0;
    this.currentTurn = this.turnOrder[0];

    return { ok: true };
  }

  // =====================
  // MOVEMENT
  // =====================

  getValidMoves(playerId) {
    const station = this.positions[playerId];
    const t = this.tickets[playerId];
    const isMrX = playerId === this.mrX;
    const moves = []; // { station, ticket }

    const occupied = new Set();
    // Detectives block stations (but not Mr. X's hidden position)
    for (const detId of this.detectives) {
      occupied.add(this.positions[detId]);
    }

    const addMoves = (adj, ticketType) => {
      const neighbors = adj[station] || [];
      for (const dest of neighbors) {
        // Detectives can't move to occupied stations
        if (!isMrX && occupied.has(dest)) continue;
        // Mr. X can't move to detective-occupied stations
        if (isMrX && occupied.has(dest)) continue;

        if (t[ticketType] > 0) {
          moves.push({ station: dest, ticket: ticketType });
        }
        // Mr. X can also use black ticket for any transport
        if (isMrX && t.black > 0 && ticketType !== 'black') {
          moves.push({ station: dest, ticket: 'black' });
        }
      }
    };

    addMoves(TAXI, 'taxi');
    addMoves(BUS, 'bus');
    addMoves(UNDERGROUND, 'underground');
    if (isMrX) {
      addMoves(FERRY, 'black'); // ferry only with black ticket
    }

    // Deduplicate (same station + same ticket)
    const seen = new Set();
    return moves.filter(m => {
      const key = `${m.station}-${m.ticket}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  makeMove(playerId, destination, ticket) {
    if (this.phase !== 'playing') return { error: 'Game not in progress' };
    if (this.currentTurn !== playerId) return { error: 'Not your turn' };

    const isMrX = playerId === this.mrX;
    const validMoves = this.getValidMoves(playerId);
    const moveValid = validMoves.some(m => m.station === destination && m.ticket === ticket);
    if (!moveValid) return { error: 'Invalid move' };

    // Execute move
    this.positions[playerId] = destination;
    this.tickets[playerId][ticket]--;

    // If detective used a ticket, give it to Mr. X (effectively unlimited, but track for display)
    if (!isMrX) {
      // Mr. X gains the used ticket (already has 99, but this is thematic)
    }

    // Mr. X travel log
    if (isMrX) {
      const isRevealed = REVEAL_ROUNDS.includes(this.round);
      this.travelLog.push({
        round: this.round,
        ticket,
        station: destination,
        revealed: isRevealed,
      });
      if (isRevealed) {
        this.mrXLastKnown = destination;
      }
    }

    // Check win conditions after detective move
    if (!isMrX) {
      // Did detective land on Mr. X?
      if (destination === this.positions[this.mrX]) {
        this.phase = 'ended';
        this.winner = 'detectives';
        this.winReason = `${this.players[playerId].name} caught Mr. X at station ${destination}!`;
        return { ok: true, gameOver: true };
      }
    }

    // Advance turn
    return this._advanceTurn();
  }

  // Mr. X uses double move
  useDoubleMove(playerId) {
    if (playerId !== this.mrX) return { error: 'Only Mr. X can use double move' };
    if (this.currentTurn !== playerId) return { error: 'Not your turn' };
    if (this.tickets[playerId].doubleMoves <= 0) return { error: 'No double moves left' };
    if (this.isDoubleMoveFirstHalf) return { error: 'Already in a double move' };

    this.tickets[playerId].doubleMoves--;
    this.isDoubleMoveFirstHalf = true;
    return { ok: true };
  }

  _advanceTurn() {
    // If Mr. X is in double move first half, let him go again
    if (this.isDoubleMoveFirstHalf && this.currentTurn === this.mrX) {
      this.isDoubleMoveFirstHalf = false;
      // Mr. X goes again — don't advance turnIndex
      return { ok: true };
    }

    this.turnIndex++;

    // If we've gone through all players, new round
    if (this.turnIndex >= this.turnOrder.length) {
      return this._startNewRound();
    }

    this.currentTurn = this.turnOrder[this.turnIndex];

    // Skip stranded detectives
    while (this._isStranded(this.currentTurn)) {
      this.players[this.currentTurn].stranded = true;
      this.turnIndex++;
      if (this.turnIndex >= this.turnOrder.length) {
        return this._startNewRound();
      }
      this.currentTurn = this.turnOrder[this.turnIndex];
    }

    return { ok: true };
  }

  _startNewRound() {
    this.round++;

    // Check if Mr. X survived all rounds
    if (this.round > MAX_ROUNDS) {
      this.phase = 'ended';
      this.winner = 'mrx';
      this.winReason = `Mr. X evaded capture for ${MAX_ROUNDS} rounds!`;
      return { ok: true, gameOver: true };
    }

    // Check if all detectives are stranded
    const allStranded = this.detectives.every(d => this._isStranded(d));
    if (allStranded) {
      this.phase = 'ended';
      this.winner = 'mrx';
      this.winReason = 'All detectives are stranded — Mr. X wins!';
      return { ok: true, gameOver: true };
    }

    // Check if Mr. X is trapped (no valid moves)
    this.turnIndex = 0;
    this.currentTurn = this.turnOrder[0]; // Mr. X
    if (this.getValidMoves(this.mrX).length === 0) {
      this.phase = 'ended';
      this.winner = 'detectives';
      this.winReason = 'Mr. X has no valid moves — detectives win!';
      return { ok: true, gameOver: true };
    }

    return { ok: true, newRound: true };
  }

  _isStranded(playerId) {
    if (playerId === this.mrX) return false; // Mr. X has unlimited tickets
    return this.getValidMoves(playerId).length === 0;
  }

  // =====================
  // STATE FOR CLIENTS
  // =====================

  // State visible to detectives (Mr. X position hidden except on reveal rounds)
  getDetectiveView() {
    const detectivePositions = {};
    for (const detId of this.detectives) {
      detectivePositions[detId] = this.positions[detId];
    }

    return {
      phase: this.phase,
      round: this.round,
      maxRounds: MAX_ROUNDS,
      currentTurn: this.currentTurn,
      turnOrder: this.turnOrder,
      players: this._sanitizePlayers(),
      mrX: this.mrX,
      detectives: this.detectives,
      positions: detectivePositions,
      mrXLastKnown: this.mrXLastKnown,
      travelLog: this.travelLog.map(e => ({
        round: e.round,
        ticket: e.ticket,
        station: e.revealed ? e.station : null,
        revealed: e.revealed,
      })),
      tickets: this._sanitizeTickets(false),
      revealRounds: REVEAL_ROUNDS,
      winner: this.winner,
      winReason: this.winReason,
      isDoubleMoveFirstHalf: this.isDoubleMoveFirstHalf,
    };
  }

  // State visible to Mr. X (sees everything)
  getMrXView() {
    return {
      phase: this.phase,
      round: this.round,
      maxRounds: MAX_ROUNDS,
      currentTurn: this.currentTurn,
      turnOrder: this.turnOrder,
      players: this._sanitizePlayers(),
      mrX: this.mrX,
      detectives: this.detectives,
      positions: { ...this.positions }, // Mr. X sees all positions including own
      mrXLastKnown: this.mrXLastKnown,
      travelLog: this.travelLog,
      tickets: this._sanitizeTickets(true),
      revealRounds: REVEAL_ROUNDS,
      winner: this.winner,
      winReason: this.winReason,
      isDoubleMoveFirstHalf: this.isDoubleMoveFirstHalf,
    };
  }

  // After game ends, reveal everything
  getEndView() {
    return {
      phase: this.phase,
      round: this.round,
      maxRounds: MAX_ROUNDS,
      currentTurn: this.currentTurn,
      turnOrder: this.turnOrder,
      players: this._sanitizePlayers(),
      mrX: this.mrX,
      detectives: this.detectives,
      positions: { ...this.positions },
      mrXLastKnown: this.mrXLastKnown,
      travelLog: this.travelLog, // full log with all stations
      tickets: this._sanitizeTickets(true),
      revealRounds: REVEAL_ROUNDS,
      winner: this.winner,
      winReason: this.winReason,
      isDoubleMoveFirstHalf: false,
    };
  }

  getStateForPlayer(playerId) {
    if (this.phase === 'ended') return this.getEndView();
    if (playerId === this.mrX) return this.getMrXView();
    return this.getDetectiveView();
  }

  _sanitizePlayers() {
    const result = {};
    for (const [id, p] of Object.entries(this.players)) {
      result[id] = {
        name: p.name,
        role: p.role,
        isAI: p.isAI,
        stranded: p.stranded,
      };
    }
    return result;
  }

  _sanitizeTickets(showMrX) {
    const result = {};
    for (const [id, t] of Object.entries(this.tickets)) {
      if (id === this.mrX && !showMrX) {
        // Detectives can see Mr. X's special tickets only
        result[id] = { black: t.black, doubleMoves: t.doubleMoves };
      } else {
        result[id] = { ...t };
      }
    }
    return result;
  }
}

module.exports = GameState;
