from fastapi import APIRouter, HTTPException, Query
from app.services import youtube_service
from app.services.music import MusicService

router = APIRouter(prefix="/api/search", tags=["search"])
music_service = MusicService()


@router.get("")
async def search_music(
    q: str = Query(..., min_length=1),
    limit: int = Query(10, ge=1, le=25),
    source: str = Query("preview", pattern="^(preview|full)$"),
):
    try:
        if source == "full":
            return {"results": await youtube_service.search_youtube(q, limit)}
        return {"results": await music_service.search_songs(q, limit)}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Search failed: {exc}") from exc
