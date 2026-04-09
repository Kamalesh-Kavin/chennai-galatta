# Chennai Galatta — Online Multiplayer

A fully playable online multiplayer implementation of the classic asymmetric deduction board game, re-themed as a chase through the streets of Chennai. One player controls The Don fleeing across the city, while up to five Inspectors work together to track and capture him. Any empty role is automatically filled by AI, so you can play solo, with one friend, or with a full group.

Built as a single-page web app with real-time WebSocket synchronization — no accounts, no downloads, just share the link and play.

## Features

- **Full Scotland Yard rules**: 22 rounds, 199 stations, auto/bus/metro/boat transport
- **Chennai-themed map**: SVG map with real Chennai districts — Anna Nagar, T. Nagar, Mylapore, Adyar, George Town, Egmore, and more
- **Flexible player/AI mixing**: Any role (The Don or Inspectors 1–5) can be human or AI — empty slots auto-filled with bots
- **Real-time multiplayer**: WebSocket-based state sync via Socket.IO
- **The Don's reveal mechanic**: Position hidden except on rounds 3, 8, 13, 18, 22
- **Double moves**: The Don can take two consecutive turns (twice per game)
- **Black tickets**: The Don has 5 wildcard tickets usable on any transport (including boats)
- **Smart AI**: Heuristic-based AI for both The Don (evasion) and Inspectors (pursuit)
- **Interactive board**: Canvas rendering with zoom/pan (mouse, touch, buttons), station highlighting, animated player tokens
- **How to Play guide**: Built-in rules overlay for new players
- **Game review**: Step-by-step replay of the entire game after it ends
- **Responsive UI**: Glassmorphism panels, Google Fonts, works on desktop and tablet

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Server | Node.js + Express 5 |
| Real-time | Socket.IO 4.8 |
| Frontend | Vanilla JavaScript + HTML Canvas |
| State | Server-authoritative (no client trust) |
| Map | SVG background + Canvas overlay |

**~5,100 lines of code** across 8 source files. Zero external frontend dependencies.

## Getting Started

### Prerequisites

- Node.js >= 18.0.0

### Local Development

```bash
git clone https://github.com/Kamalesh-Kavin/chennai-galatta.git
cd chennai-galatta
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

1. **Lobby**: Enter your name and choose a role — The Don or Inspector. Unclaimed roles are filled by AI.
2. **The Don's goal**: Evade capture for 22 rounds by moving secretly across Chennai.
3. **Inspectors' goal**: Land on The Don's station to catch him before round 22 ends.
4. **Turns**: The Don moves first each round, then Inspectors in order. Each move uses a ticket (auto, bus, or metro).
5. **Travel log**: The Don's ticket type is always visible, but his station is hidden — except on **reveal rounds** (3, 8, 13, 18, 22).
6. **Special moves**: The Don has **5 black tickets** (wildcard, also needed for boats) and **2 double moves** (take two consecutive turns).
7. **Inspectors win** if any Inspector lands on The Don's station, or if The Don has no valid moves.
8. **The Don wins** if he survives all 22 rounds, or if all Inspectors are stranded (no valid moves).

---

## System Architecture

```
┌─────────────────────────────────────────────────┐
│                   Browser                        │
│  ┌─────────────────────────────────────────────┐ │
│  │  client.js (1899 lines)                     │ │
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
│  │  index.js (395 lines)            │         │ │
│  │  Express 5 + Socket.IO           │         │ │
│  │  ┌────────────────┐  ┌───────────┴───────┐ │ │
│  │  │ GameState.js   │  │ AI.js             │ │ │
│  │  │ (501 lines)    │  │ (190 lines)       │ │ │
│  │  │ Rules engine   │  │ Heuristic bots    │ │ │
│  │  └───────┬────────┘  └───────────────────┘ │ │
│  │          │                                  │ │
│  │  ┌───────┴────────┐                        │ │
│  │  │ map.js (565 ln)│                        │ │
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

The Don receives `getMrXView()` (sees everything). Inspectors receive `getDetectiveView()` (The Don's position hidden except on reveal rounds). After game ends, everyone gets `getEndView()` with full information.

---

## Implementation Details

### Server (`server/index.js` — 395 lines)

Express serves static files from `public/`. A single Socket.IO namespace handles all game communication.

**Socket Events (Client → Server):**

| Event | Payload | Description |
|-------|---------|-------------|
| `join` | `{ name, role }` | Join lobby as `mrx` or `detective` |
| `leave` | — | Leave lobby |
| `startGame` | — | Start game (fills empty slots with AI) |
| `move` | `{ destination, ticket }` | Make a move on your turn |
| `useDoubleMove` | — | The Don activates double move |
| `getValidMoves` | — (ack callback) | Request valid moves for current position |
| `resetGame` | — | Reset to lobby |
| `getAdjacency` | — | Request map adjacency data |

**Socket Events (Server → Client):**

| Event | Description |
|-------|-------------|
| `lobbyState` | Lobby info: player list, roles, phase |
| `gameState` | Role-filtered game state (positions, tickets, travel log, etc.) |
| `adjacency` | Map data: auto/bus/metro/boat adjacency lists |
| `error` | Validation error message |

**AI Turn Processing**: After each human move, the server runs an async loop checking if it's an AI player's turn. AI moves are delayed by 800ms for realism. If AI is stranded (no valid moves), it's marked and skipped.

**Disconnect Handling**: Disconnected players are replaced by AI (name appended with "(DC)"). If it was their turn, AI takes over immediately.

### Game Engine (`server/game/GameState.js` — 501 lines)

Fully server-authoritative rules engine.

**Game Phases:**
1. **Lobby** — Players join, choose roles
2. **Playing** — Turn-based movement across 22 rounds
3. **Ended** — Winner determined, all info revealed

**Turn Flow:**
```
Round start → The Don moves → Inspector 1 → Inspector 2 → ... → Inspector 5 → Round end
                     ↑                                                            │
                     └── (if double move: The Don goes again before Inspectors) ──┘
```

**Ticket System:**
- The Don: 99 auto / 99 bus / 99 metro / 5 black / 2 double moves
- Each Inspector: 11 auto / 8 bus / 4 metro

Inspectors spend tickets (finite supply). The Don effectively has unlimited standard tickets. Black tickets are wildcards usable on any connection type, and are the only way to use boats.

**Win Conditions:**
- **Inspectors win**: An Inspector lands on The Don's station, or The Don has no valid moves
- **The Don wins**: Survives past round 22, or all Inspectors are stranded

**Key Methods:**

| Method | Description |
|--------|-------------|
| `getValidMoves(playerId)` | Computes all legal `{ station, ticket }` pairs from current position |
| `makeMove(playerId, dest, ticket)` | Validates and applies move, updates travel log, checks capture, advances turn |
| `useDoubleMove(playerId)` | Activates The Don's double move ability |
| `getStateForPlayer(playerId)` | Returns role-filtered state (Don view vs Inspector view) |
| `fillWithAI()` | Fills empty slots with AI players |
| `startGame()` | Assigns random starting positions, distributes tickets |

### AI System (`server/game/AI.js` — 190 lines)

Heuristic scoring system — no tree search or lookahead.

**The Don AI — Evasion Strategy:**

| Factor | Weight | Logic |
|--------|--------|-------|
| Distance from Inspectors | +10 per unit | Euclidean distance in map coordinates |
| Escape routes | +3 per neighbor | Number of connections from destination |
| Adjacent Inspectors | -20 per Inspector | Penalty for destinations near Inspectors |
| Ticket conservation | +2 auto, +1 bus, -3 black | Prefers cheap tickets |
| Reveal round bonus | +5 per unit distance | Extra weight on rounds 3/8/13/18/22 |
| Metro access | +4 | Prefers stations with metro |

Selects randomly from the **top 3** scoring moves for unpredictability.

**Double Move Decision**: Triggers when 2+ Inspectors are adjacent, or when only 0–1 safe escape routes exist.

**Inspector AI — Pursuit Strategy:**

| Factor | Weight | Logic |
|--------|--------|-------|
| Get closer to target | +15 per unit closer | Target = last known Don position, or map center |
| Avoid clustering | -10 if too close to ally | Promotes spread across the board |
| Hub preference | +2 per connection | Prefers well-connected stations |
| Ticket conservation | +1 auto, -2 metro | Saves expensive tickets |

Selects randomly from the **top 2** scoring moves.

### Map Data (`server/data/map.js` — 565 lines)

Standard 199-station topology matching the original Scotland Yard board game, themed as Chennai locations.

| Data | Count |
|------|-------|
| Stations | 199 |
| Auto connections | ~350 undirected edges |
| Bus connections | ~130 undirected edges |
| Metro connections | ~24 undirected edges |
| Boat connections | 3 undirected edges |
| Metro stations | 14 |
| Bus stations | 62 |
| Boat stations | 4 (108, 115, 157, 194) |
| Starting positions | 18 |
| Reveal rounds | 5 (rounds 3, 8, 13, 18, 22) |

Station positions are mapped onto a 1000x700 coordinate grid. The SVG map background uses the same coordinate space for pixel-perfect alignment.

### SVG Map (`public/img/chennai-map.svg` — 214 lines)

Hand-crafted SVG background matching the 1000x700 station coordinate grid:

- Warm terracotta/beige base reflecting Chennai's tropical feel
- 14 colored district zones (Anna Nagar, Egmore, T. Nagar, Mylapore, Adyar, George Town, etc.)
- Major road network (Anna Salai, Poonamallee High Road, GST Road, ECR, Inner Ring Road, Kamarajar Salai)
- Green areas (Anna Nagar Tower Park, Guindy National Park, Theosophical Society, Semmozhi Poonga, IIT Madras)
- Landmarks (Fort St. George, Kapaleeshwarar Temple, Chennai Central Station, Anna Nagar Tower)
- 21 district labels, compass rose, decorative border

### Client (`public/js/client.js` — 1899 lines)

Single-file vanilla JS client handling all UI, rendering, and socket communication.

**Canvas Rendering Pipeline** (`renderBoard()`):

```
1. Size canvas to container (DPR-aware)
2. Compute transform: map coords (1000x700) → screen pixels
   scale = baseScale × boardZoom
   offset = canvasCenter + panOffset
3. Draw layers:
   a. Background fill (#d8ccb8)
   b. SVG map image (chennai-map.svg) — aligned to coordinate system
   c. Connections (drawConnections) — auto/bus/metro/boat lines
   d. Stations (drawStations) — shaped by transport type
   e. Player tokens (drawPlayers) — gradient circles with labels
```

**Connection Rendering**: 8 problematic connections are drawn as quadratic bezier curves instead of straight lines, preventing visual confusion where a line passes through an unconnected intermediate station. Configured via `CURVED_CONNECTIONS` map with signed offsets controlling curve direction.

**Station Shapes**:
- Diamond — metro station
- Rounded square — bus station
- Circle — auto-only station

**Animation System**: `requestAnimationFrame` loop cycling 0–1 every 2 seconds. Powers pulsing highlights on valid move targets, current-turn player tokens, and The Don's last known position indicator.

**Zoom/Pan**: Mouse drag, scroll wheel, touch pan/pinch, and button controls. Coordinates are transformed through the zoom/pan state in `toCanvas()`.

### CSS (`public/css/style.css` — 1240 lines)

Dark-themed UI panels with bright map contrast:
- CSS custom properties (colors, fonts, glass effects)
- Google Fonts: Playfair Display (headings) + Inter (body)
- Glassmorphism sidebar panels (`backdrop-filter: blur(16px)`)
- Responsive layout with mobile hamburger menu
- Transport-colored ticket badges and legend

## Project Structure

```
chennai-galatta/
├── server/
│   ├── index.js              # Express + Socket.IO server (395 lines)
│   ├── game/
│   │   ├── GameState.js      # Game rules engine (501 lines)
│   │   └── AI.js             # AI for The Don and Inspectors (190 lines)
│   └── data/
│       └── map.js            # 199 stations, adjacency, positions (565 lines)
├── public/
│   ├── index.html            # Single-page app (159 lines)
│   ├── css/
│   │   └── style.css         # All styling (1240 lines)
│   ├── js/
│   │   └── client.js         # Game client (1899 lines)
│   └── img/
│       └── chennai-map.svg   # Chennai map background (214 lines)
├── package.json
├── render.yaml               # Render deployment blueprint
└── .gitignore
```

## Credits

Game mechanics based on the board game [Scotland Yard](https://en.wikipedia.org/wiki/Scotland_Yard_(board_game)) by Ravensburger.

## License

ISC
