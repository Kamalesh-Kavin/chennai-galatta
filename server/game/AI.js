// Scotland Yard — AI Logic
// Smart AI for both Mr. X and detective roles

const { TAXI, BUS, UNDERGROUND, FERRY, STATION_POSITIONS } = require('../data/map');

class AI {
  // Get AI move for a player
  static getMove(gameState, playerId) {
    const isMrX = playerId === gameState.mrX;
    const validMoves = gameState.getValidMoves(playerId);

    if (validMoves.length === 0) return null;

    if (isMrX) {
      return AI._mrXMove(gameState, playerId, validMoves);
    } else {
      return AI._detectiveMove(gameState, playerId, validMoves);
    }
  }

  // Should Mr. X use double move?
  static shouldUseDoubleMove(gameState) {
    const mrXPos = gameState.positions[gameState.mrX];
    const tickets = gameState.tickets[gameState.mrX];
    if (tickets.doubleMoves <= 0) return false;

    // Use double move if a detective is adjacent
    const detPositions = gameState.detectives.map(d => gameState.positions[d]);
    const neighbors = AI._getAllNeighbors(mrXPos);
    const adjacentDetectives = detPositions.filter(p => neighbors.includes(p));

    // Use if 2+ detectives are adjacent, or if trapped after normal move
    if (adjacentDetectives.length >= 2) return true;

    // Use if most valid moves lead close to detectives
    const validMoves = gameState.getValidMoves(gameState.mrX);
    const safeMoves = validMoves.filter(m => {
      const destNeighbors = AI._getAllNeighbors(m.station);
      const closeDetectives = detPositions.filter(p => destNeighbors.includes(p));
      return closeDetectives.length === 0;
    });

    if (safeMoves.length <= 1 && adjacentDetectives.length >= 1) return true;

    return false;
  }

  // =====================
  // MR. X AI
  // =====================

  static _mrXMove(gameState, playerId, validMoves) {
    const detPositions = gameState.detectives.map(d => gameState.positions[d]);

    // Score each move
    const scored = validMoves.map(move => {
      let score = 0;

      // 1. Distance from detectives (higher = better)
      const minDist = Math.min(...detPositions.map(dp => AI._distance(move.station, dp)));
      score += minDist * 10;

      // 2. Number of connections from destination (more options = better escape routes)
      const futureConnections = AI._getAllNeighbors(move.station).length;
      score += futureConnections * 3;

      // 3. Avoid stations adjacent to detectives
      const destNeighbors = AI._getAllNeighbors(move.station);
      const adjacentDetectives = detPositions.filter(p => destNeighbors.includes(p));
      score -= adjacentDetectives.length * 20;

      // 4. Prefer using taxi (saves special tickets)
      if (move.ticket === 'taxi') score += 2;
      if (move.ticket === 'bus') score += 1;
      if (move.ticket === 'black') score -= 3; // conserve black tickets

      // 5. On reveal rounds, try to be far from detectives
      const isRevealRound = gameState.round <= 22 &&
        [3, 8, 13, 18, 22].includes(gameState.round);
      if (isRevealRound) {
        score += minDist * 5; // extra weight on distance
      }

      // 6. Prefer underground stations (more mobility)
      if (UNDERGROUND[move.station]) score += 4;

      return { ...move, score };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Add some randomness — pick from top 3
    const topN = Math.min(3, scored.length);
    const pick = Math.floor(Math.random() * topN);
    return { station: scored[pick].station, ticket: scored[pick].ticket };
  }

  // =====================
  // DETECTIVE AI
  // =====================

  static _detectiveMove(gameState, playerId, validMoves) {
    const mrXLastKnown = gameState.mrXLastKnown;
    const mrXLog = gameState.travelLog;
    const detPositions = gameState.detectives.map(d => gameState.positions[d]);
    const myPos = gameState.positions[playerId];
    const myTickets = gameState.tickets[playerId];

    // Estimate Mr. X's possible locations
    let targetStation = mrXLastKnown || 100; // center of map if unknown

    // If we know Mr. X's last position, extrapolate based on travel log
    if (mrXLastKnown && mrXLog.length > 0) {
      const lastRevealIdx = mrXLog.findIndex(e => e.revealed && e.station === mrXLastKnown);
      if (lastRevealIdx >= 0) {
        // Count moves since last reveal
        const movesSince = mrXLog.length - lastRevealIdx - 1;
        // Target is still the last known position — detectives converge there
        targetStation = mrXLastKnown;
      }
    }

    // Score each move
    const scored = validMoves.map(move => {
      let score = 0;

      // 1. Get closer to estimated Mr. X position
      const currentDist = AI._distance(myPos, targetStation);
      const newDist = AI._distance(move.station, targetStation);
      score += (currentDist - newDist) * 15; // reward getting closer

      // 2. Don't cluster with other detectives
      const minDetDist = Math.min(...detPositions
        .filter(p => p !== myPos)
        .map(p => AI._distance(move.station, p)));
      if (minDetDist <= 1) score -= 10; // too close to another detective
      if (minDetDist >= 3) score += 5;  // good spread

      // 3. Prefer central positions (more connections = more coverage)
      const connections = AI._getAllNeighbors(move.station).length;
      score += connections * 2;

      // 4. Conserve tickets — prefer taxi, save underground
      if (move.ticket === 'taxi') score += 1;
      if (move.ticket === 'underground') score -= 2;

      // 5. Prefer stations with underground access (future mobility)
      if (UNDERGROUND[move.station]) score += 3;

      // 6. Ticket conservation — don't use a ticket type if running low
      if (myTickets[move.ticket] <= 2) score -= 5;

      return { ...move, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Pick the best move (less randomness for detectives — they cooperate)
    const topN = Math.min(2, scored.length);
    const pick = Math.floor(Math.random() * topN);
    return { station: scored[pick].station, ticket: scored[pick].ticket };
  }

  // =====================
  // HELPERS
  // =====================

  static _getAllNeighbors(station) {
    const neighbors = new Set();
    for (const adj of [TAXI, BUS, UNDERGROUND, FERRY]) {
      for (const n of (adj[station] || [])) {
        neighbors.add(n);
      }
    }
    return [...neighbors];
  }

  static _distance(a, b) {
    // Euclidean distance based on station positions (approximate board distance)
    const posA = STATION_POSITIONS[a];
    const posB = STATION_POSITIONS[b];
    if (!posA || !posB) return 50; // fallback
    const dx = posA.x - posB.x;
    const dy = posA.y - posB.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
}

module.exports = AI;
