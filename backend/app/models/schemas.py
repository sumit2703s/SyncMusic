from typing import List, Optional

from pydantic import BaseModel, Field


class Song(BaseModel):
    songId: str
    title: str
    artist: str
    thumbnail: str
    duration: str
    durationSec: int = 30
    previewUrl: str


class RoomState(BaseModel):
    roomId: str
    songId: Optional[str] = None
    previewUrl: Optional[str] = None
    title: Optional[str] = None
    artist: Optional[str] = None
    thumbnail: Optional[str] = None
    duration: Optional[str] = None
    timestamp: float = 0.0
    isPlaying: bool = False
    startedAt: Optional[float] = None
    hostId: Optional[str] = None


class UserPresence(BaseModel):
    userId: str
    username: str


class RoomDetails(BaseModel):
    state: RoomState
    queue: List[Song] = Field(default_factory=list)
    users: List[UserPresence] = Field(default_factory=list)


class CreateRoomRequest(BaseModel):
    roomId: Optional[str] = ""
    userId: str
    username: str


class JoinRoomRequest(BaseModel):
    roomId: str
    userId: str
    username: str
