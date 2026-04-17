from fastapi import APIRouter, HTTPException

from app.services import youtube_service

router = APIRouter(prefix="/api/resolve", tags=["resolve"])

@router.get("/{video_id}")
async def resolve_song(video_id: str):
    """
    Resolve a YouTube video ID into a fresh streaming URL.
    """
    url = await youtube_service.resolve_url(video_id)
    if not url:
        raise HTTPException(status_code=404, detail="Could not resolve streaming URL for this song.")
    
    return {"url": url}
