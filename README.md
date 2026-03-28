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
4. Focused screen view
- highlights the claimed tile
- shows local track geometry and train entering/exiting through correct edges
- users can return to lobby at any time

## Backend architecture (`backend/server.js`)
- In-memory session state keyed by stable `clientId`
- Universal password validation through `POST /api/auth`
- Session check endpoint `GET /api/session`
- WebSocket endpoint `/ws` for realtime snapshots + client actions
- Deterministic topology and route generation:
- occupied cells = station + claimed user cells
- BFS spanning tree rooted at station
- DFS walk over that tree produces a coherent closed route through all occupied cells and back to station
- Server-authoritative train schedule with timestamps:
- `cycleStartTimeMs`
- per-segment duration (`segmentDurationMs`)
- route segment count / cycle duration
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
- `ping`

Server broadcasts state snapshots with:
- grid + station
- claimed cells and claimable cells
- per-tile rail edges
- route nodes
- schedule timestamps
- self/client session info
