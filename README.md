# SyncMusic 🎵

A real-time, social music streaming platform that allows you and your friends to listen to music in perfect synchronization. 

Whether you want to discover full tracks via YouTube or quickly browse snippets with high-quality previews, SyncMusic keeps everyone in the room on the same beat.

## ✨ Features

- **Perfect Sync**: Real-time playback synchronization via WebSockets and Redis.
- **Dual Search Source**: 
  - **YouTube Mode**: Resolve and stream full YouTube tracks.
  - **Preview Mode**: Instant high-quality short previews from Deezer/iTunes.
- **Room System**: Create or join rooms with unique IDs.
- **Interactive UI**: Sleek, glassmorphism-based design with optimistic controls for zero-latency feel.
- **Social Management**: Host-based skip, kick, and queue management.

## 🛠 Tech Stack

- **Frontend**: React, Vite, Socket.io-client, Vanilla CSS.
- **Backend**: Python (FastAPI), Socket.io (python-socketio), Uvicorn.
- **Data State**: Redis (State/Queue), MongoDB (User management).
- **Processing**: yt-dlp & YTMusicAPI for media resolution.

## 🚀 Quick Start

### Prerequisites
- Node.js & npm
- Python 3.10+
- Redis server (local or cloud)
- MongoDB server (local or cloud)

### Installation

1. **Clone the repo**
   ```bash
   git clone https://github.com/yourusername/SyncMusic.git
   cd SyncMusic
   ```

2. **Setup Backend**
   ```bash
   cd backend
   python -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

3. **Setup Frontend**
   ```bash
   cd ../frontend
   npm install
   ```

4. **Environment Variables**
   Create a `.env` in the root and `frontend/` directories (see `.env.example` for details).

5. **Run Locally**
   - **Backend**: `uvicorn app.main:app --reload` (port 8000)
   - **Frontend**: `npm run dev` (port 3000)

## 🌐 Deployment

This project is optimized for deployment on **Render** (Backend) and **Vercel** (Frontend). Detailed instructions can be found in [DEPLOYMENT.md](./DEPLOYMENT.md).

## 📄 License

MIT License. See [LICENSE.md](./LICENSE.md) if applicable.
