import os

import socketio
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes.resolve import router as resolve_router
from app.routes.room import router as room_router
from app.routes.search import router as search_router
from app.socket_manager import sio

load_dotenv()

fastapi_app = FastAPI(title="Music Sync API")

# Use environment variables for CORS in production
cors_origins_raw = os.getenv("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
allowed_origins = [origin.strip() for origin in cors_origins_raw.split(",") if origin.strip()]

fastapi_app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

fastapi_app.include_router(search_router)
fastapi_app.include_router(room_router)
fastapi_app.include_router(resolve_router)


@fastapi_app.get("/health")
async def health():
    return {"status": "ok"}


socket_app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)
# Keep backward compatibility for `uvicorn app.main:app`
app = socket_app
