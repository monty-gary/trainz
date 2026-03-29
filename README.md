# trainz

Shared multi-screen railway prototype.

Each browser/device acts as one tile in a shared grid. Participants authenticate with one universal password, choose a username, claim a valid adjacent tile, and watch a synchronized train route that is scheduled server-side.

## Repo structure
- `frontend/`: Vite + React + TypeScript (GitHub Pages target)
- `backend/`: Node.js + WebSocket realtime backend (Render target)

## Product flow
1. Password gate (`frontend` calls backend `/api/auth`)
2. Username setup
3. Lobby map
- 2D grid
- central station in middle cell
- claimable cells are empty cells adjacent to station or any claimed tile
- each claimed tile has a signal touch zone:
  - `red` = stop
  - `green` = passthrough
  - only the tile owner can toggle, but everyone sees current signal state
4. Focused screen view
- highlights the claimed tile with a larger locomotive + wagon and a readable overlapping signal node
- shows local track geometry, signal mode, and train entering/exiting through the correct edges
- shows tile fruit inventory (5 slots) and shared wagon cargo slots (5 slots)
- supports pointer drag/drop (mouse and touch) between tile slots, wagon slots, and discard
- users can return to lobby at any time
5. Fruit cargo transfer loop
- each claimed tile gets 5 fruit slots
- when a tile is claimed, the backend seeds exactly 3 random fruit slots from `apple|banana|pear|grapes|peach`
- owner can load/unload the shared wagon while the train is stopped at their tile
- another owner can stop the same train at their tile and unload/swap fruit into their own tile slots

## Backend architecture (`backend/server.js`)
- In-memory session state keyed by stable `clientId`
- Universal password validation through `POST /api/auth`
- Session check endpoint `GET /api/session`
- WebSocket endpoint `/ws` for realtime snapshots + client actions
- Per-claimed-tile signal state (`red` stop / `green` passthrough), owner-toggled
- Server-authoritative fruit state:
- `tileSlots` (5) on each claimed tile
- one shared `wagonSlots` inventory (5) synchronized to all clients
- deterministic server-side fruit seeding on claim
- tile release removes that tile's fruit inventory
- Deterministic topology and route generation:
- occupied cells = station + claimed user cells
- BFS spanning tree rooted at station
- DFS walk over that tree produces a coherent closed route through all occupied cells and back to station
- Server-authoritative train runtime + schedule data:
- current segment index and segment start time
- per-segment duration (`segmentDurationMs`)
- paused state + paused-at tile when stopped by a red signal
- deterministic progression along route edges
- Clients correct local clock using server timestamps from snapshots

## Frontend architecture (`frontend/src`)
- `App.tsx`: full UX flow + websocket lifecycle + lobby/focused views
- `api.ts`: backend URL resolution + auth/session API helpers
- `train.ts`: deterministic train interpolation for map and focused tile rendering
- `types.ts`: shared message/state types

## Environment variables

### Backend (Render)
- `PORT`: Render-provided port
- `TRAINZ_PASSWORD`: shared password (default: `allaboard`)
- `GRID_SIZE`: map size, normalized to odd number (default: `9`)
- `TRAIN_SEGMENT_MS`: segment duration in ms (default: `2200`)
- `TRAIN_SCHEDULE_LEAD_MS`: schedule lead time after topology change (default: `1200`)
- `CORS_ORIGIN`: CORS origin (default: `*`)

### Frontend (Vite / GitHub Pages build)
- `VITE_API_BASE_URL`: backend base URL (example: `https://your-service.onrender.com`)
- Fallback behavior:
- local dev on `localhost` -> `http://localhost:3000`
- non-localhost -> `https://trainz-backend.onrender.com`

## Local development

### Backend
```bash
cd backend
npm install
npm run dev
```

Health check:
```bash
curl http://localhost:3000/health
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

## Production build (frontend)
```bash
cd frontend
npm run build
```

Build output: `frontend/dist/`

## Deployment
- GitHub Pages deploys frontend from `frontend/dist` via `.github/workflows/deploy-pages.yml` (branch `dev`)
- Render deploys backend from `backend/` using `npm install` then `npm run start`

## Realtime client actions
WebSocket client messages:
- `set_username`
- `claim_cell`
- `release_cell`
- `toggle_signal`
- `move_fruit` (`from` tile/wagon slot -> `to` tile/wagon slot or `discard`)
- `ping`

Server broadcasts state snapshots with:
- grid + station
- claimed cells and claimable cells
- signal state on each claimed tile
- tile slots
- shared wagon slots
- per-tile rail edges
- route nodes
- schedule timestamps
- server-authoritative train runtime (`segmentIndex`, `segmentStartTimeMs`, `paused`, `pausedAt`)
- self/client session info

## Signal stop behavior
- The backend is authoritative for train stop/resume decisions.
- When the train reaches a claimed tile with a `red` signal, it pauses at that tile center.
- Toggling that tile back to `green` resumes motion from the backend state machine.
- If multiple red signals exist, the train stops deterministically at the next red tile encountered on the current route.

## Cargo transfer rule
- Cargo moves are backend-validated and rejected unless all conditions hold:
- requesting client owns a currently claimed tile
- train is paused
- paused train tile equals the requesting client's claimed tile
- When allowed, clients can drag/drop to swap:
- tile <-> wagon
- tile <-> tile (reorder/swap)
- wagon <-> wagon (reorder/swap)
- and can discard by dropping to `discard`.
