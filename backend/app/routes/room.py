import secrets
import time
from typing import Any

from fastapi import APIRouter, HTTPException

from app.models.schemas import CreateRoomRequest, JoinRoomRequest
from app.services.mongo_service import MongoService
from app.services.redis_service import RedisService
from app.socket_manager import sio, user_sid_map

router = APIRouter(prefix="/api/rooms", tags=["rooms"])
from app.services import mongo_service, redis_service


@router.post("/create")
async def create_room(payload: CreateRoomRequest):
    room_id = payload.roomId or secrets.token_hex(3)
    await redis_service.create_room(room_id, payload.userId)
    await redis_service.add_user(room_id, payload.userId, payload.username)
    await mongo_service.upsert_user(payload.userId, payload.username)
    return {"roomId": room_id, "hostId": payload.userId}


@router.post("/join")
async def join_room(payload: JoinRoomRequest):
    state = await redis_service.get_room_state(payload.roomId)
    if not state:
        raise HTTPException(status_code=404, detail="Room not found")

    await redis_service.add_user(payload.roomId, payload.userId, payload.username)
    await mongo_service.upsert_user(payload.userId, payload.username)

    queue = await redis_service.get_queue(payload.roomId)
    users = await redis_service.get_users(payload.roomId)
    return {"roomId": payload.roomId, "state": state, "queue": queue, "users": users}


@router.post("/{room_id}/queue")
async def add_song_to_queue(room_id: str, payload: dict[str, Any]):
    song = payload.get("song")
    if not isinstance(song, dict):
        raise HTTPException(status_code=400, detail="Invalid song payload")

    required = ("songId", "title", "artist", "thumbnail", "duration")
    missing = [key for key in required if not song.get(key)]
    if missing:
        raise HTTPException(status_code=400, detail=f"Missing song fields: {', '.join(missing)}")

    await redis_service.add_to_queue(room_id, song)
    queue = await redis_service.get_queue(room_id)
    await sio.emit("queue_updated", {"roomId": room_id, "queue": queue}, room=room_id)
    return {"success": True, "queue": queue}


@router.post("/{room_id}/play")
async def play_song(room_id: str, payload: dict[str, Any]):
    song = payload.get("song")
    timestamp = float(payload.get("timestamp", 0.0))
    if not isinstance(song, dict):
        raise HTTPException(status_code=400, detail="Invalid song payload")

    state = await redis_service.get_room_state(room_id) or {}
    state.update(
        {
            "songId": song.get("songId", ""),
            "previewUrl": song.get("previewUrl", ""),
            "title": song.get("title", ""),
            "artist": song.get("artist", ""),
            "thumbnail": song.get("thumbnail", ""),
            "duration": song.get("duration", ""),
            "durationSec": song.get("durationSec", 30),
            "source": song.get("source", "preview"),
            "timestamp": timestamp,
            "isPlaying": True,
            "startedAt": time.time(),
        }
    )
    await redis_service.set_room_state(room_id, state)
    await sio.emit("song_changed", {"roomId": room_id, "state": state}, room=room_id)
    return {"success": True, "state": state}


@router.post("/{room_id}/pause")
async def pause_song(room_id: str, payload: dict[str, Any]):
    timestamp = float(payload.get("timestamp", 0.0))
    state = await redis_service.get_room_state(room_id) or {}
    state.update({"timestamp": timestamp, "isPlaying": False, "startedAt": None})
    await redis_service.set_room_state(room_id, state)
    await sio.emit("song_paused", {"roomId": room_id, "state": state}, room=room_id)
    return {"success": True, "state": state}


@router.post("/{room_id}/next")
async def play_next_song(room_id: str):
    current_state = await redis_service.get_room_state(room_id) or {}
    if current_state.get("songId"):
        await redis_service.push_history(
            room_id,
            {
                "songId": current_state.get("songId", ""),
                "previewUrl": current_state.get("previewUrl", ""),
                "title": current_state.get("title", "Previously played"),
                "artist": current_state.get("artist", "Unknown Artist"),
                "thumbnail": current_state.get("thumbnail", ""),
                "duration": current_state.get("duration", "0:30"),
                "durationSec": int(current_state.get("durationSec", 30)),
                "source": current_state.get("source", "preview"),
            },
        )

    song = await redis_service.pop_next_song(room_id)
    if not song:
        await sio.emit("queue_empty", {"roomId": room_id}, room=room_id)
        return {"success": True, "queueEmpty": True}

    state = await redis_service.get_room_state(room_id) or {}
    state.update(
        {
            "songId": song.get("songId", ""),
            "previewUrl": song.get("previewUrl", ""),
            "title": song.get("title", ""),
            "artist": song.get("artist", ""),
            "thumbnail": song.get("thumbnail", ""),
            "duration": song.get("duration", ""),
            "durationSec": song.get("durationSec", 30),
            "source": song.get("source", "preview"),
            "timestamp": 0.0,
            "isPlaying": True,
            "startedAt": time.time(),
        }
    )
    await redis_service.set_room_state(room_id, state)
    queue = await redis_service.get_queue(room_id)
    await sio.emit("song_changed", {"roomId": room_id, "state": state, "song": song, "queue": queue}, room=room_id)
    return {"success": True, "state": state, "queue": queue}


@router.post("/{room_id}/prev")
async def play_previous_song(room_id: str):
    previous_song = await redis_service.pop_history(room_id)
    if not previous_song:
        await sio.emit("queue_empty", {"roomId": room_id}, room=room_id)
        return {"success": True, "historyEmpty": True}

    state = await redis_service.get_room_state(room_id) or {}
    state.update(
        {
            "songId": previous_song.get("songId", ""),
            "previewUrl": previous_song.get("previewUrl", ""),
            "title": previous_song.get("title", ""),
            "artist": previous_song.get("artist", ""),
            "thumbnail": previous_song.get("thumbnail", ""),
            "duration": previous_song.get("duration", ""),
            "durationSec": previous_song.get("durationSec", 30),
            "source": previous_song.get("source", "preview"),
            "timestamp": 0.0,
            "startedAt": time.time(),
            "isPlaying": True,
        }
    )
    await redis_service.set_room_state(room_id, state)
    await sio.emit("song_restarted", {"roomId": room_id, "state": state, "song": previous_song}, room=room_id)
    return {"success": True, "state": state}


@router.post("/{room_id}/kick")
async def kick_member(room_id: str, payload: dict[str, Any]):
    by_user_id = payload.get("byUserId")
    target_user_id = payload.get("targetUserId")
    if not by_user_id or not target_user_id:
        raise HTTPException(status_code=400, detail="Missing byUserId or targetUserId")

    state = await redis_service.get_room_state(room_id) or {}
    if state.get("hostId") != by_user_id:
        raise HTTPException(status_code=403, detail="Only host can remove members")
    if by_user_id == target_user_id:
        raise HTTPException(status_code=400, detail="Host cannot remove themselves")

    await redis_service.remove_user(room_id, target_user_id)
    target_sid = user_sid_map.pop(target_user_id, None)
    if target_sid:
        await sio.leave_room(target_sid, room_id)
        await sio.emit("kicked", {"roomId": room_id}, room=target_sid)

    users = await redis_service.get_users(room_id)
    await sio.emit("user_left", {"roomId": room_id, "userId": target_user_id, "users": users}, room=room_id)
    return {"success": True, "users": users}
