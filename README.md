# trainz

`trainz` is now split into a frontend and backend inside one repository.

## Repository structure
- `frontend/`: Vite + React + TypeScript app (GitHub Pages target)
- `backend/`: Minimal Node.js web service placeholder (Render-ready shape)

## Frontend
The frontend renders the stylized railway scene with the animated train.

Run locally:
```bash
cd frontend
npm install
npm run dev
```

Build production assets:
```bash
cd frontend
npm run build
```

Output directory: `frontend/dist/`

## Backend
The backend is a minimal HTTP service that listens on `PORT` and exposes:
- `GET /` returning a simple JSON payload
- `GET /health` returning a health response

Run locally:
```bash
cd backend
npm install
npm run start
```

Optional dev mode:
```bash
cd backend
npm run dev
```

## Deployment
- GitHub Pages deploys automatically from branch `dev` via `.github/workflows/deploy-pages.yml`.
- The workflow builds the frontend from `frontend/` and publishes `frontend/dist/`.
- The site URL remains: `https://monty-gary.github.io/trainz/`.

## Notes
- Frontend source and styling live under `frontend/src/`.
- Backend is a placeholder service intended as a starting point for a future Render deployment.
