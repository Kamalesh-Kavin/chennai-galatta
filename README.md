# Scotland Yard — Online Multiplayer

A fully playable online multiplayer implementation of the classic asymmetric deduction board game. One player controls the elusive Mr. X fleeing across London, while up to five detectives work together to track and capture him. Any empty role is automatically filled by AI, so you can play solo, with one friend, or with a full group.

Built as a single-page web app with real-time WebSocket synchronization — no accounts, no downloads, just share the link and play.

## Features

- **Full Scotland Yard rules**: 22 rounds, 199 stations, taxi/bus/underground/ferry transport
- **Flexible player/AI mixing**: Any role (Mr. X or detectives 1–5) can be human or AI — empty slots auto-filled with bots
- **London map board**: Bright SVG map background with districts, Thames River, parks, bridges, and landmarks
- **Real-time multiplayer**: WebSocket-based state sync via Socket.IO
- **Mr. X reveal mechanic**: Position hidden except on rounds 3, 8, 13, 18, 22
- **Double moves**: Mr. X can take two consecutive turns (twice per game)
- **Black tickets**: Mr. X has 5 wildcard tickets usable on any transport (including ferries)
- **Smart AI**: Heuristic-based AI for both Mr. X (evasion) and detectives (pursuit)
- **Interactive board**: Canvas rendering with zoom/pan (mouse, touch, buttons), station highlighting, animated player tokens
- **How to Play guide**: Built-in rules overlay for new players
- **Responsive UI**: Glassmorphism panels, Google Fonts, works on desktop and tablet

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Server | Node.js + Express 5 |
| Real-time | Socket.IO 4.8 |
| Frontend | Vanilla JavaScript + HTML Canvas |
| State | Server-authoritative (no client trust) |
| Map | SVG background + Canvas overlay |

**~3,700 lines of code** across 8 source files. Zero external frontend dependencies.

## Getting Started

### Prerequisites

- Node.js >= 18.0.0

### Local Development

```bash
git clone https://github.com/Kamalesh-Kavin/scotland-yard.git
cd scotland-yard
npm install
npm run dev
```

Open `http://localhost:3000` in your browser. Share the URL with friends on your network.

### Production

```bash
npm start
```

The server reads the `PORT` environment variable (defaults to 3000).

## Deployment

### Render (Recommended)

This repo includes a `render.yaml` blueprint for one-click deployment:

1. Connect this repo on [Render](https://render.com)
2. Create a new **Blueprint** and select this repository
3. Render auto-configures everything from `render.yaml`
4. Your game will be live at the assigned URL

### Railway

1. Connect this repo on [Railway](https://railway.app)
2. Railway auto-detects Node.js and runs `npm start`
3. `PORT` is set automatically

## How to Play

1. **Lobby**: Enter your name and choose a role — Mr. X or Detective. Unclaimed roles are filled by AI.
2. **Mr. X's goal**: Evade capture for 22 rounds by moving secretly across London.
3. **Detectives' goal**: Land on Mr. X's station to catch him before round 22 ends.
4. **Turns**: Mr. X moves first each round, then detectives in order. Each move uses a ticket (taxi, bus, or underground).
5. **Travel log**: Mr. X's ticket type is always visible, but his station is hidden — except on **reveal rounds** (3, 8, 13, 18, 22).
6. **Special moves**: Mr. X has **5 black tickets** (wildcard, also needed for ferries) and **2 double moves** (take two consecutive turns).
7. **Detectives win** if any detective lands on Mr. X's station, or if Mr. X has no valid moves.
8. **Mr. X wins** if he survives all 22 rounds, or if all detectives are stranded (no valid moves).

---

## System Architecture

```
┌─────────────────────────────────────────────────┐
│                   Browser                        │
│  ┌─────────────────────────────────────────────┐ │
│  │  client.js (1144 lines)                     │ │
│  │  ┌──────────┐ ┌──────────┐ ┌─────────────┐ │ │
│  │  │ Canvas   │ │ UI Panels│ │ Socket.IO   │ │ │
│  │  │ Renderer │ │ (DOM)    │ │ Client      │ │ │
│  │  └──────────┘ └──────────┘ └──────┬──────┘ │ │
│  └───────────────────────────────────┼─────────┘ │
└──────────────────────────────────────┼───────────┘
                                       │ WebSocket
┌──────────────────────────────────────┼───────────┐
│                   Server             │           │
│  ┌───────────────────────────────────┼─────────┐ │
│  │  index.js (265 lines)            │         │ │
│  │  Express 5 + Socket.IO           │         │ │
│  │  ┌────────────────┐  ┌───────────┴───────┐ │ │
│  │  │ GameState.js   │  │ AI.js             │ │ │
│  │  │ (444 lines)    │  │ (190 lines)       │ │ │
│  │  │ Rules engine   │  │ Heuristic bots    │ │ │
│  │  └───────┬────────┘  └───────────────────┘ │ │
│  │          │                                  │ │
│  │  ┌───────┴────────┐                        │ │
│  │  │ map.js (588 ln)│                        │ │
│  │  │ 199 stations   │                        │ │
│  │  │ Adjacency data │                        │ │
│  │  └────────────────┘                        │ │
│  └────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### Single-Room Model

One global `GameState` instance per server. No multi-room support — designed for a small group of friends sharing a deployment. Simple and stateless (no database needed).

### State Flow

```
Client action (move, join, etc.)
  → Socket.IO event to server
    → GameState validates & updates
      → broadcastState() sends role-filtered views to each player
        → Client re-renders board + UI
```

Mr. X receives `getMrXView()` (sees everything). Detectives receive `getDetectiveView()` (Mr. X position hidden except on reveal rounds). After game ends, everyone gets `getEndView()` with full information.

---

## Implementation Details

### Server (`server/index.js` — 265 lines)

Express serves static files from `public/`. A single Socket.IO namespace handles all game communication.

**Socket Events (Client → Server):**

| Event | Payload | Description |
|-------|---------|-------------|
| `join` | `{ name, role }` | Join lobby as `mrx` or `detective` |
| `leave` | — | Leave lobby |
| `startGame` | — | Start game (fills empty slots with AI) |
| `move` | `{ destination, ticket }` | Make a move on your turn |
| `useDoubleMove` | — | Mr. X activates double move |
| `getValidMoves` | — (ack callback) | Request valid moves for current position |
| `resetGame` | — | Reset to lobby |
| `getAdjacency` | — | Request map adjacency data |

**Socket Events (Server → Client):**

| Event | Description |
|-------|-------------|
| `lobbyState` | Lobby info: player list, roles, phase |
| `gameState` | Role-filtered game state (positions, tickets, travel log, etc.) |
| `adjacency` | Map data: taxi/bus/underground/ferry adjacency lists |
| `error` | Validation error message |

**AI Turn Processing**: After each human move, the server runs an async loop checking if it's an AI player's turn. AI moves are delayed by 800ms for realism. If AI is stranded (no valid moves), it's marked and skipped.

**Disconnect Handling**: Disconnected players are replaced by AI (name appended with "(DC)"). If it was their turn, AI takes over immediately.

### Game Engine (`server/game/GameState.js` — 444 lines)

Fully server-authoritative rules engine.

**Game Phases:**
1. **Lobby** — Players join, choose roles
2. **Playing** — Turn-based movement across 22 rounds
3. **Ended** — Winner determined, all info revealed

**Turn Flow:**
```
Round start → Mr. X moves → Detective 1 → Detective 2 → ... → Detective 5 → Round end
                    ↑                                                            │
                    └── (if double move: Mr. X goes again before detectives) ────┘
```

**Ticket System:**
- Mr. X: 99 taxi / 99 bus / 99 underground / 5 black / 2 double moves
- Each detective: 11 taxi / 8 bus / 4 underground

Detectives spend tickets (finite supply). Mr. X effectively has unlimited standard tickets. Black tickets are wildcards usable on any connection type, and are the only way to use ferries.

**Win Conditions:**
- **Detectives win**: A detective lands on Mr. X's station, or Mr. X has no valid moves
- **Mr. X wins**: Survives past round 22, or all detectives are stranded

**Key Methods:**

| Method | Description |
|--------|-------------|
| `getValidMoves(playerId)` | Computes all legal `{ station, ticket }` pairs from current position |
| `makeMove(playerId, dest, ticket)` | Validates and applies move, updates travel log, checks capture, advances turn |
| `useDoubleMove(playerId)` | Activates Mr. X's double move ability |
| `getStateForPlayer(playerId)` | Returns role-filtered state (Mr. X view vs detective view) |
| `fillWithAI()` | Fills empty slots with AI players |
| `startGame()` | Assigns random starting positions, distributes tickets |

### AI System (`server/game/AI.js` — 190 lines)

Heuristic scoring system — no tree search or lookahead.

**Mr. X AI — Evasion Strategy:**

| Factor | Weight | Logic |
|--------|--------|-------|
| Distance from detectives | +10 per unit | Euclidean distance in map coordinates |
| Escape routes | +3 per neighbor | Number of connections from destination |
| Adjacent detectives | -20 per detective | Penalty for destinations near detectives |
| Ticket conservation | +2 taxi, +1 bus, -3 black | Prefers cheap tickets |
| Reveal round bonus | +5 per unit distance | Extra weight on rounds 3/8/13/18/22 |
| Underground access | +4 | Prefers stations with underground |

Selects randomly from the **top 3** scoring moves for unpredictability.

**Double Move Decision**: Triggers when 2+ detectives are adjacent, or when only 0–1 safe escape routes exist.

**Detective AI — Pursuit Strategy:**

| Factor | Weight | Logic |
|--------|--------|-------|
| Get closer to target | +15 per unit closer | Target = last known Mr. X position, or map center |
| Avoid clustering | -10 if too close to ally | Promotes spread across the board |
| Hub preference | +2 per connection | Prefers well-connected stations |
| Ticket conservation | +1 taxi, -2 underground | Saves expensive tickets |

Selects randomly from the **top 2** scoring moves.

### Map Data (`server/data/map.js` — 588 lines)

Standard 199-station topology from the classic board game.

| Data | Count |
|------|-------|
| Stations | 199 |
| Taxi connections | 347 undirected edges |
| Bus connections | 130 undirected edges |
| Underground connections | 24 undirected edges |
| Ferry connections | 3 undirected edges |
| Underground stations | 16 |
| Bus stations | 83 |
| Ferry stations | 4 (108, 115, 157, 194) |
| Starting positions | 18 |
| Reveal rounds | 5 (rounds 3, 8, 13, 18, 22) |

Station positions are mapped onto a 1000x700 coordinate grid. The SVG map background uses the same coordinate space for pixel-perfect alignment.

### Client (`public/js/client.js` — 1144 lines)

Single-file vanilla JS client handling all UI, rendering, and socket communication.

**Canvas Rendering Pipeline** (`renderBoard()`):

```
1. Size canvas to container (DPR-aware)
2. Compute transform: map coords (1000x700) → screen pixels
   scale = baseScale × boardZoom
   offset = canvasCenter + panOffset
3. Draw layers:
   a. Background fill (#d8ccb8)
   b. SVG map image (london-map.svg) — aligned to coordinate system
   c. Connections (drawConnections) — taxi/bus/underground/ferry lines
   d. Stations (drawStations) — shaped by transport type
   e. Player tokens (drawPlayers) — gradient circles with labels
```

**Connection Rendering**: 8 problematic connections are drawn as quadratic bezier curves instead of straight lines, preventing visual confusion where a line passes through an unconnected intermediate station. Configured via `CURVED_CONNECTIONS` map with signed offsets controlling curve direction.

**Station Shapes**:
- Diamond — underground station
- Rounded square — bus station
- Circle — taxi-only station

**Animation System**: `requestAnimationFrame` loop cycling 0–1 every 2 seconds. Powers pulsing highlights on valid move targets, current-turn player tokens, and Mr. X's last known position indicator.

**Zoom/Pan**: Mouse drag, scroll wheel, touch pan/pinch, and button controls. Coordinates are transformed through the zoom/pan state in `toCanvas()`.

### SVG Map (`public/img/london-map.svg` — 317 lines)

Hand-crafted SVG background matching the 1000x700 station coordinate grid:

- Warm parchment base (#e8dcc8)
- 14 colored district zones (Paddington, Marylebone, Soho, The City, Westminster, etc.)
- Thames River at y≈418–448 (matching the actual gap between station rows)
- 7 bridges at real crossing points (where taxi connections span the river)
- Green parks (Regent's Park, Hyde Park, St James's Park)
- Street grid (major roads + minor cross streets)
- Landmark icons (Big Ben, Tower of London, St Paul's, Buckingham Palace)
- District labels, compass rose, decorative border

### CSS (`public/css/style.css` — 929 lines)

Dark-themed UI panels with bright map contrast:
- 33 CSS custom properties (colors, fonts, glass effects)
- Google Fonts: Playfair Display (headings) + Inter (body)
- Glassmorphism sidebar panels (`backdrop-filter: blur(16px)`)
- Responsive layout with mobile hamburger menu
- Transport-colored ticket badges and legend

## Project Structure

```
scotland-yard/
├── server/
│   ├── index.js              # Express + Socket.IO server (265 lines)
│   ├── game/
│   │   ├── GameState.js      # Game rules engine (444 lines)
│   │   └── AI.js             # AI for Mr. X and detectives (190 lines)
│   └── data/
│       └── map.js            # 199 stations, adjacency, positions (588 lines)
├── public/
│   ├── index.html            # Single-page app (118 lines)
│   ├── css/
│   │   └── style.css         # All styling (929 lines)
│   ├── js/
│   │   └── client.js         # Game client (1144 lines)
│   └── img/
│       └── london-map.svg    # London map background (317 lines)
├── package.json
├── render.yaml               # Render deployment blueprint
└── .gitignore
```

## License

ISC
