import os
import time
from typing import Any

import socketio

from app.services import mongo_service, redis_service

cors_origins_raw = os.getenv("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
if cors_origins_raw == "*":
    allowed_origins = "*"
else:
    allowed_origins = [origin.strip() for origin in cors_origins_raw.split(",") if origin.strip()]

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins=allowed_origins,
)
user_sid_map: dict[str, str] = {}


def _compute_sync_time(state: dict[str, Any]) -> float:
    timestamp = float(state.get("timestamp", 0.0))
    if not state.get("isPlaying") or state.get("startedAt") is None:
        return timestamp
    return timestamp + max(0.0, (time.time() - float(state["startedAt"])))


@sio.event
async def connect(sid, environ, auth):
    await sio.emit("connected", {"sid": sid}, room=sid)


@sio.event
async def disconnect(sid):
    disconnected_user_ids = [user_id for user_id, mapped_sid in user_sid_map.items() if mapped_sid == sid]
    for user_id in disconnected_user_ids:
        user_sid_map.pop(user_id, None)
    return


@sio.on("join_room")
async def join_room(sid, data):
    room_id = data.get("roomId")
    user_id = data.get("userId")
    username = data.get("username")

    if not room_id or not user_id or not username:
        return {"success": False, "error": "Missing roomId, userId, or username"}

    await sio.enter_room(sid, room_id)
    user_sid_map[user_id] = sid
    await redis_service.add_user(room_id, user_id, username)
    await mongo_service.upsert_user(user_id, username)

    state = await redis_service.get_room_state(room_id)
    if not state:
        await redis_service.create_room(room_id, user_id)
        state = await redis_service.get_room_state(room_id)

    queue = await redis_service.get_queue(room_id)
    users = await redis_service.get_users(room_id)
    current_time = _compute_sync_time(state or {})

    await sio.emit(
        "room_state",
        {
            "roomId": room_id,
            "state": state,
            "queue": queue,
            "users": users,
            "syncTime": current_time,
        },
        room=sid,
    )
    await sio.emit("user_joined", {"roomId": room_id, "user": {"userId": user_id, "username": username}}, room=room_id)
    return {"success": True, "roomId": room_id, "state": state, "queue": queue, "users": users}


@sio.on("leave_room")
async def leave_room(sid, data):
    room_id = data["roomId"]
    user_id = data["userId"]

    await sio.leave_room(sid, room_id)
    user_sid_map.pop(user_id, None)
    await redis_service.remove_user(room_id, user_id)

    users = await redis_service.get_users(room_id)
    state = await redis_service.get_room_state(room_id) or {}

    if state.get("hostId") == user_id and users:
        state["hostId"] = users[0]["userId"]
        await redis_service.set_room_state(room_id, state)
        await sio.emit("host_changed", {"roomId": room_id, "hostId": state["hostId"]}, room=room_id)

    await sio.emit("user_left", {"roomId": room_id, "userId": user_id, "users": users}, room=room_id)
    await redis_service.clear_room_if_empty(room_id, ttl_seconds=3600)


@sio.on("kick_user")
async def kick_user(sid, data):
    room_id = data.get("roomId")
    target_user_id = data.get("targetUserId")
    by_user_id = data.get("byUserId")

    if not room_id or not target_user_id or not by_user_id:
        return {"success": False, "error": "Missing roomId, targetUserId, or byUserId"}

    state = await redis_service.get_room_state(room_id) or {}
    if state.get("hostId") != by_user_id:
        return {"success": False, "error": "Only host can remove members"}
    if target_user_id == by_user_id:
        return {"success": False, "error": "Host cannot remove themselves"}

    await redis_service.remove_user(room_id, target_user_id)
    target_sid = user_sid_map.pop(target_user_id, None)
    if target_sid:
        await sio.leave_room(target_sid, room_id)
        await sio.emit("kicked", {"roomId": room_id}, room=target_sid)

    users = await redis_service.get_users(room_id)
    await sio.emit("user_left", {"roomId": room_id, "userId": target_user_id, "users": users}, room=room_id)
    return {"success": True, "users": users}


@sio.on("play_song")
async def play_song(sid, data):
    room_id = data.get("roomId")
    song = data.get("song")
    print(f"DEBUG: play_song [START] room: {room_id}, song: {song.get('title') if song else 'None'}")
    if not room_id or not song:
        return {"success": False, "error": "Missing roomId or song"}
    
    timestamp = float(data.get("timestamp", 0.0))
    state = await redis_service.get_room_state(room_id) or {}
    
    current_song = state.get("songId")
    if current_song and current_song != song.get("songId"):
        await redis_service.push_history(
            room_id,
            {
                "songId": current_song,
                "previewUrl": state.get("previewUrl", ""),
                "title": state.get("title", "Previously played"),
                "artist": state.get("artist", "Unknown Artist"),
                "thumbnail": state.get("thumbnail", ""),
                "duration": state.get("duration", "0:30"),
                "durationSec": int(data.get("currentDurationSec", 30)),
            },
        )

    state.update(
        {
            "songId": song["songId"],
            "previewUrl": song.get("previewUrl", ""),
            "title": song["title"],
            "artist": song["artist"],
            "thumbnail": song["thumbnail"],
            "duration": song["duration"],
            "durationSec": song.get("durationSec", 30),
            "source": song.get("source", "preview"),
            "timestamp": timestamp,
            "isPlaying": True,
            "startedAt": time.time(),
        }
    )
    await redis_service.set_room_state(room_id, state)
    await sio.emit("song_changed", {"roomId": room_id, "state": state}, room=room_id)
    print("DEBUG: play_song [EMIT_SUCCESS]")
    return {"success": True}


@sio.on("pause_song")
async def pause_song(sid, data):
    room_id = data["roomId"]
    timestamp = float(data.get("timestamp", 0.0))
    state = await redis_service.get_room_state(room_id) or {}
    state.update({"timestamp": timestamp, "isPlaying": False, "startedAt": None})
    await redis_service.set_room_state(room_id, state)
    await sio.emit("song_paused", {"roomId": room_id, "state": state}, room=room_id)


@sio.on("sync_time")
async def sync_time(sid, data):
    room_id = data["roomId"]
    timestamp = float(data.get("timestamp", 0.0))
    is_playing = bool(data.get("isPlaying", False))
    state = await redis_service.get_room_state(room_id) or {}
    state.update(
        {
            "timestamp": timestamp,
            "isPlaying": is_playing,
            "startedAt": time.time() if is_playing else None,
        }
    )
    await redis_service.set_room_state(room_id, state)
    await sio.emit("sync_time", {"roomId": room_id, "timestamp": timestamp, "isPlaying": is_playing}, room=room_id, skip_sid=sid)


@sio.on("add_to_queue")
async def add_to_queue(sid, data):
    room_id = data.get("roomId")
    song = data.get("song")
    song_title = song.get("title", "Unknown") if isinstance(song, dict) else "Unknown"
    print(f"DEBUG: add_to_queue [START] room: {room_id}, song: {song_title}")
    if not room_id or not song:
        print("DEBUG: add_to_queue [ERROR] Missing roomId or song")
        return {"success": False, "error": "Missing roomId or song"}

    try:
        await redis_service.add_to_queue(room_id, song)
        print("DEBUG: add_to_queue [REDIS_WRITE_SUCCESS]")
        queue = await redis_service.get_queue(room_id)
        print(f"DEBUG: add_to_queue [REDIS_READ_SUCCESS] Queue size: {len(queue)}")
        await sio.emit("queue_updated", {"roomId": room_id, "queue": queue}, room=room_id)
        print("DEBUG: add_to_queue [EMIT_SUCCESS]")
        return {"success": True, "queue": queue}
    except Exception as e:
        print(f"DEBUG: add_to_queue [EXCEPTION]: {e}")
        return {"success": False, "error": str(e)}


@sio.on("next_song")
async def next_song(sid, data):
    room_id = data["roomId"]
    current_state = await redis_service.get_room_state(room_id) or {}
    if current_state.get("songId"):
        await redis_service.push_history(
            room_id,
            {
                "songId": current_state["songId"],
                "previewUrl": current_state.get("previewUrl", ""),
                "title": current_state.get("title", "Previously played"),
                "artist": current_state.get("artist", "Unknown Artist"),
                "thumbnail": current_state.get("thumbnail", ""),
                "duration": current_state.get("duration", "0:30"),
                "durationSec": int(data.get("currentDurationSec", 30)),
            },
        )

    song = await redis_service.pop_next_song(room_id)
    if not song:
        await sio.emit("queue_empty", {"roomId": room_id}, room=room_id)
        return

    state = await redis_service.get_room_state(room_id) or {}
    state.update(
        {
            "songId": song["songId"],
            "previewUrl": song["previewUrl"],
            "title": song["title"],
            "artist": song["artist"],
            "thumbnail": song["thumbnail"],
            "duration": song["duration"],
            "timestamp": 0.0,
            "isPlaying": True,
            "startedAt": time.time(),
        }
    )
    await redis_service.set_room_state(room_id, state)
    queue = await redis_service.get_queue(room_id)
    await sio.emit("song_changed", {"roomId": room_id, "state": state, "song": song, "queue": queue}, room=room_id)


@sio.on("prev_song")
async def prev_song(sid, data):
    room_id = data["roomId"]
    previous_song = await redis_service.pop_history(room_id)
    if not previous_song:
        await sio.emit("queue_empty", {"roomId": room_id}, room=room_id)
        return

    state = await redis_service.get_room_state(room_id) or {}
    state.update(
        {
            "songId": previous_song["songId"],
            "previewUrl": previous_song["previewUrl"],
            "title": previous_song["title"],
            "artist": previous_song["artist"],
            "thumbnail": previous_song["thumbnail"],
            "duration": previous_song["duration"],
            "timestamp": 0.0,
            "startedAt": time.time(),
            "isPlaying": True,
        }
    )
    await redis_service.set_room_state(room_id, state)
    await sio.emit("song_restarted", {"roomId": room_id, "state": state, "song": previous_song}, room=room_id)
