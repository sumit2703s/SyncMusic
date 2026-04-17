import asyncio
import json
import os
import time
from typing import Any, Optional

from redis.asyncio import Redis


class RedisService:
    def __init__(self) -> None:
        redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
        self.redis = None
        self.redis_url = redis_url
        self._memory_lock = asyncio.Lock()
        self._memory_state: dict[str, dict[str, Any]] = {}
        self._memory_queue: dict[str, list[dict[str, Any]]] = {}
        self._memory_users: dict[str, dict[str, str]] = {}
        self._memory_history: dict[str, list[dict[str, Any]]] = {}

        try:
            # Do not ping in __init__: this module is imported inside an active event loop.
            self.redis = Redis.from_url(redis_url, decode_responses=True)
        except Exception as e:
            print(f"Error creating Redis client for {redis_url}: {e}")
            self.redis = None

    async def ping(self) -> bool:
        if self.redis is None:
            return False
        try:
            return await self.redis.ping()
        except Exception:
            return False

    @staticmethod
    def _state_key(room_id: str) -> str:
        return f"room:{room_id}:state"

    @staticmethod
    def _queue_key(room_id: str) -> str:
        return f"room:{room_id}:queue"

    @staticmethod
    def _users_key(room_id: str) -> str:
        return f"room:{room_id}:users"

    @staticmethod
    def _usernames_key(room_id: str) -> str:
        return f"room:{room_id}:usernames"

    @staticmethod
    def _history_key(room_id: str) -> str:
        return f"room:{room_id}:history"

    async def create_room(self, room_id: str, host_id: str) -> None:
        if self.redis is None:
            async with self._memory_lock:
                self._memory_state[room_id] = {
                    "songId": "",
                    "previewUrl": "",
                    "title": "",
                    "artist": "",
                    "thumbnail": "",
                    "duration": "",
                    "timestamp": 0.0,
                    "isPlaying": False,
                    "startedAt": None,
                    "hostId": host_id,
                }
                self._memory_queue.setdefault(room_id, [])
                self._memory_users.setdefault(room_id, {})
                self._memory_history.setdefault(room_id, [])
            return
        base_state = {
            "songId": "",
            "previewUrl": "",
            "title": "",
            "artist": "",
            "thumbnail": "",
            "duration": "",
            "timestamp": 0.0,
            "isPlaying": False,
            "startedAt": None,
            "hostId": host_id,
        }
        try:
            await self.redis.set(self._state_key(room_id), json.dumps(base_state))
        except Exception as e:
            print(f"Error creating room: {e}")

    async def set_room_state(self, room_id: str, state: dict[str, Any]) -> None:
        if self.redis is None:
            async with self._memory_lock:
                self._memory_state[room_id] = dict(state)
            return
        try:
            await self.redis.set(self._state_key(room_id), json.dumps(state))
        except Exception as e:
            print(f"Error setting room state: {e}")

    async def get_room_state(self, room_id: str) -> Optional[dict[str, Any]]:
        if self.redis is None:
            async with self._memory_lock:
                state = self._memory_state.get(room_id)
                return dict(state) if state else None
        try:
            data = await self.redis.get(self._state_key(room_id))
            return json.loads(data) if data else None
        except Exception as e:
            print(f"Error getting room state: {e}")
            return None

    async def add_user(self, room_id: str, user_id: str, username: str) -> None:
        if self.redis is None:
            async with self._memory_lock:
                users = self._memory_users.setdefault(room_id, {})
                users[user_id] = username
            return
        try:
            await self.redis.sadd(self._users_key(room_id), user_id)
            await self.redis.hset(self._usernames_key(room_id), user_id, username)
        except Exception as e:
            print(f"Error adding user: {e}")

    async def remove_user(self, room_id: str, user_id: str) -> None:
        if self.redis is None:
            async with self._memory_lock:
                users = self._memory_users.get(room_id, {})
                users.pop(user_id, None)
            return
        try:
            await self.redis.srem(self._users_key(room_id), user_id)
            await self.redis.hdel(self._usernames_key(room_id), user_id)
        except Exception as e:
            print(f"Error removing user: {e}")

    async def get_users(self, room_id: str) -> list[dict[str, str]]:
        if self.redis is None:
            async with self._memory_lock:
                users = self._memory_users.get(room_id, {})
                return [{"userId": uid, "username": uname or "Guest"} for uid, uname in users.items()]
        try:
            user_ids = await self.redis.smembers(self._users_key(room_id))
            users: list[dict[str, str]] = []
            for user_id in user_ids:
                username = await self.redis.hget(self._usernames_key(room_id), user_id)
                users.append({"userId": user_id, "username": username or "Guest"})
            return users
        except Exception as e:
            print(f"Error getting users: {e}")
            return []

    async def add_to_queue(self, room_id: str, song: dict[str, Any]) -> None:
        if self.redis is None:
            async with self._memory_lock:
                self._memory_queue.setdefault(room_id, []).append(dict(song))
            return
        try:
            await self.redis.rpush(self._queue_key(room_id), json.dumps(song))
        except Exception as e:
            print(f"Error adding to queue: {e}")

    async def pop_next_song(self, room_id: str) -> Optional[dict[str, Any]]:
        if self.redis is None:
            async with self._memory_lock:
                queue = self._memory_queue.get(room_id, [])
                if not queue:
                    return None
                return dict(queue.pop(0))
        try:
            data = await self.redis.lpop(self._queue_key(room_id))
            return json.loads(data) if data else None
        except Exception as e:
            print(f"Error popping from queue: {e}")
            return None

    async def get_queue(self, room_id: str) -> list[dict[str, Any]]:
        if self.redis is None:
            async with self._memory_lock:
                return [dict(item) for item in self._memory_queue.get(room_id, [])]
        try:
            items = await self.redis.lrange(self._queue_key(room_id), 0, -1)
            return [json.loads(item) for item in items]
        except Exception as e:
            print(f"Error getting queue: {e}")
            return []

    async def push_history(self, room_id: str, song: dict[str, Any]) -> None:
        if self.redis is None:
            async with self._memory_lock:
                self._memory_history.setdefault(room_id, []).append(dict(song))
            return
        try:
            await self.redis.rpush(self._history_key(room_id), json.dumps(song))
        except Exception as e:
            print(f"Error pushing to history: {e}")

    async def pop_history(self, room_id: str) -> Optional[dict[str, Any]]:
        if self.redis is None:
            async with self._memory_lock:
                history = self._memory_history.get(room_id, [])
                if not history:
                    return None
                return dict(history.pop())
        try:
            data = await self.redis.rpop(self._history_key(room_id))
            return json.loads(data) if data else None
        except Exception as e:
            print(f"Error popping from history: {e}")
            return None

    async def set_room_expiry(self, room_id: str, ttl_seconds: int = 3600) -> None:
        if self.redis is None:
            return
        keys = [
            self._state_key(room_id),
            self._queue_key(room_id),
            self._users_key(room_id),
            self._usernames_key(room_id),
            self._history_key(room_id),
        ]
        try:
            for key in keys:
                await self.redis.expire(key, ttl_seconds)
        except Exception as e:
            print(f"Error setting room expiry: {e}")

    async def clear_room_if_empty(self, room_id: str, ttl_seconds: int = 3600) -> bool:
        if self.redis is None:
            async with self._memory_lock:
                users = self._memory_users.get(room_id, {})
                if users:
                    return False
                self._memory_users.pop(room_id, None)
                self._memory_state.pop(room_id, None)
                self._memory_queue.pop(room_id, None)
                self._memory_history.pop(room_id, None)
                return True
        try:
            user_count = await self.redis.scard(self._users_key(room_id))
            if user_count == 0:
                await self.set_room_expiry(room_id, ttl_seconds)
                return True
        except Exception as e:
            print(f"Error clearing room: {e}")
        return False

    async def calculate_current_position(self, room_id: str) -> float:
        state = await self.get_room_state(room_id)
        if not state:
            return 0.0

        timestamp = float(state.get("timestamp", 0.0))
        is_playing = bool(state.get("isPlaying", False))
        started_at = state.get("startedAt")

        if not is_playing or started_at is None:
            return timestamp

        elapsed = max(0.0, time.time() - float(started_at))
        return timestamp + elapsed
