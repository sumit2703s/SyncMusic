import asyncio
from typing import Any, Optional
import yt_dlp
from ytmusicapi import YTMusic

class YouTubeService:
    def __init__(self):
        self.ydl_opts = {
            'format': 'bestaudio[ext=m4a]/bestaudio',
            'quiet': True,
            'no_warnings': True,
            'extract_flat': True,
            'skip_download': True,
            'nocheckcertificate': True,
            'ignoreerrors': True,
            'logtostderr': False,
            # Use multiple clients to bypass datacenter blocks
            'extractor_args': {
                'youtube': {
                    'player_client': ['ios', 'android', 'web']
                }
            }
        }
        self.ytmusic = YTMusic()

    async def search_youtube(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        """
        Search for tracks on YouTube Music (filters for songs only).
        """
        loop = asyncio.get_event_loop()
        
        try:
            # ytmusic.search is synchronous, run in executor
            search_results = await loop.run_in_executor(
                None, 
                lambda: self.ytmusic.search(query, filter="songs", limit=limit)
            )
            
            results = []
            for item in search_results:
                video_id = item.get('videoId')
                if not video_id:
                    continue
                
                # Extract artist name
                artists = item.get('artists', [])
                artist_name = artists[0].get('name', 'Unknown Artist') if artists else 'Unknown Artist'
                
                # Thumbnails
                thumbnails = item.get('thumbnails', [])
                thumbnail_url = thumbnails[-1].get('url', '') if thumbnails else ''
                
                results.append({
                    "songId": f"yt-{video_id}",
                    "title": item.get('title', 'Unknown Title'),
                    "artist": artist_name,
                    "thumbnail": thumbnail_url,
                    "duration": item.get('duration', '0:00'),
                    "durationSec": item.get('duration_seconds', 0),
                    "previewUrl": "", 
                    "source": "youtube"
                })
            return results
        except Exception as e:
            print(f"YouTube Music search error: {e}")
            # Fallback to standard YouTube search if YTMusic fails
            return await self._fallback_search(query, limit)

    async def _fallback_search(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        loop = asyncio.get_event_loop()
        search_query = f"ytsearch{limit}:{query} music"
        
        try:
            with yt_dlp.YoutubeDL(self.ydl_opts) as ydl:
                info = await loop.run_in_executor(None, lambda: ydl.extract_info(search_query, download=False))
                
            entries = info.get('entries', [])
            results = []
            for entry in entries:
                if not entry:
                    continue
                
                results.append({
                    "songId": f"yt-{entry['id']}",
                    "title": entry.get('title', 'Unknown Title'),
                    "artist": entry.get('uploader', 'YouTube Artist'),
                    "thumbnail": entry.get('thumbnails', [{}])[-1].get('url', ''),
                    "duration": self._format_duration(entry.get('duration', 0)),
                    "durationSec": entry.get('duration', 0),
                    "previewUrl": "",
                    "source": "youtube"
                })
            return results
        except Exception as e:
            print(f"Fallback search error: {e}")
            return []

    async def resolve_url(self, video_id: str) -> Optional[str]:
        """
        Extract a fresh streaming URL for a given video ID.
        """
        loop = asyncio.get_event_loop()
        resolve_opts = {
            'format': 'bestaudio[ext=m4a]/bestaudio',
            'quiet': True,
            'no_warnings': True,
            'skip_download': True,
        }
        
        try:
            url = f"https://www.youtube.com/watch?v={video_id}"
            resolve_opts.update(self.ydl_opts)
            resolve_opts['extract_flat'] = False # We need the actual URL
            
            with yt_dlp.YoutubeDL(resolve_opts) as ydl:
                info = await loop.run_in_executor(None, lambda: ydl.extract_info(url, download=False))
                if info and 'url' in info:
                    print(f"DEBUG: Successfully resolved URL for {video_id}")
                    return info.get('url')
                
                print(f"DEBUG: No URL in info for {video_id}. Info keys: {info.keys() if info else 'None'}")
                return None
        except Exception as e:
            print(f"YouTube resolution error for {video_id}: {e}")
            return None

    def _format_duration(self, seconds: Optional[int]) -> str:
        if not seconds:
            return "0:00"
        try:
            total_seconds = int(seconds)
            minutes = total_seconds // 60
            remaining = total_seconds % 60
            return f"{minutes}:{remaining:02d}"
        except (ValueError, TypeError):
            return "0:00"
