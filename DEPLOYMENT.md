# Deployment Guide (Render + Vercel)

This project is ready for:
- Backend on Render
- Frontend on Vercel

## 1) Deploy Backend on Render

### Option A: Blueprint (recommended)
1. Push repo to GitHub.
2. In Render, click **New +** -> **Blueprint**.
3. Select your repo. Render will detect `render.yaml`.
4. Set required environment variables in Render service:
   - `MONGO_URI` = your MongoDB connection string (Atlas or Render Mongo)
   - `REDIS_URL` = your Redis connection string (Render Redis or external)
   - `CORS_ORIGINS` = your Vercel frontend URL (example: `https://music-sync.vercel.app`)

### Option B: Manual Web Service
1. **New +** -> **Web Service** -> connect repo.
2. Set:
   - Root directory: `backend`
   - Build command: `pip install -r requirements.txt`
   - Start command: `uvicorn app.main:socket_app --host 0.0.0.0 --port $PORT`
3. Add environment variables (`MONGO_URI`, `REDIS_URL`, `CORS_ORIGINS`).

After deploy, copy backend URL (example: `https://music-sync-backend.onrender.com`).

## 2) Deploy Frontend on Vercel

1. Import the same repo in Vercel.
2. Set project root to `frontend`.
3. Build settings:
   - Framework: Vite
   - Build command: `npm run build`
   - Output directory: `dist`
4. Add Vercel environment variables:
   - `VITE_BACKEND_URL` = your Render backend URL
   - `VITE_SOCKET_URL` = your Render backend URL

Example values:
- `VITE_BACKEND_URL=https://music-sync-backend.onrender.com`
- `VITE_SOCKET_URL=https://music-sync-backend.onrender.com`

`frontend/vercel.json` is included to support SPA route rewrites.

## 3) Final CORS Update

After Vercel deploy gives your final frontend domain:
1. Go back to Render backend env vars.
2. Update `CORS_ORIGINS` to the exact Vercel URL.
3. Redeploy backend once.

## 4) Quick Production Checklist

- Backend `/health` returns `{ "status": "ok" }`
- Frontend can create and join a room
- Socket events work across two browser tabs/devices
- Redis and Mongo credentials are valid
