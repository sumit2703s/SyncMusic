import asyncio
import random
import re
from typing import Any, Optional
import yt_dlp
from ytmusicapi import YTMusic

class YouTubeService:
    def __init__(self):
        # Used for search only (extract_flat=True means no stream URL needed)
        self.ydl_search_opts = {
            'format': 'bestaudio[ext=m4a]/bestaudio/best',
            'quiet': True,
            'no_warnings': True,
            'extract_flat': True,
            'skip_download': True,
            'nocheckcertificate': True,
            'ignoreerrors': True,
            'logtostderr': False,
        }

        # Used for stream URL resolution (extract_flat MUST be False)
        self.ydl_resolve_opts = {
            'format': 'bestaudio[ext=m4a]/bestaudio/best',
            'quiet': True,
            'no_warnings': True,
            'extract_flat': False,
            'skip_download': True,
            'nocheckcertificate': True,
            'ignoreerrors': False,
            'logtostderr': False,
            'extractor_args': {
                'youtube': {
                    'player_client': ['tv_embedded', 'mweb'],
                    'skip': ['hls', 'dash'],
                }
            },
            'http_headers': {
                'User-Agent': (
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                    'AppleWebKit/537.36 (KHTML, like Gecko) '
                    'Chrome/124.0.0.0 Safari/537.36'
                ),
            },
        }

        self.ytmusic = YTMusic()
        self._cached_invidious_instances = []
        self._last_instance_fetch = 0

    # ------------------------------------------------------------------ #
    #  Search                                                              #
    # ------------------------------------------------------------------ #

    async def search_youtube(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        loop = asyncio.get_event_loop()
        try:
            search_results = await loop.run_in_executor(
                None,
                lambda: self.ytmusic.search(query, filter="songs", limit=limit)
            )

            results = []
            for item in search_results:
                video_id = item.get('videoId')
                if not video_id: continue
                artists = item.get('artists', [])
                artist_name = artists[0].get('name', 'Unknown Artist') if artists else 'Unknown Artist'
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
        except Exception:
            return await self._fallback_search(query, limit)

    async def _fallback_search(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        loop = asyncio.get_event_loop()
        search_query = f"ytsearch{limit}:{query} music"
        try:
            with yt_dlp.YoutubeDL(self.ydl_search_opts) as ydl:
                info = await loop.run_in_executor(None, lambda: ydl.extract_info(search_query, download=False))
            entries = info.get('entries', []) if info else []
            return [{
                "songId": f"yt-{e['id']}",
                "title": e.get('title', 'Unknown'),
                "artist": e.get('uploader', 'YouTube'),
                "thumbnail": e.get('thumbnails', [{}])[-1].get('url', ''),
                "duration": self._format_duration(e.get('duration', 0)),
                "durationSec": e.get('duration', 0),
                "previewUrl": "",
                "source": "youtube"
            } for e in entries if e]
        except Exception:
            return []

    # ------------------------------------------------------------------ #
    #  Ultra-Resilient Stream Resolution                                   #
    # ------------------------------------------------------------------ #

    async def resolve_url(self, video_id: str) -> Optional[str]:
        """
        Ultimate Free Resolution Strategy:
        1. Cobalt API (Fastest & most reliable on cloud)
        2. Dynamic Invidious Discovery (Self-healing proxy list)
        3. yt-dlp (Last resort hardened)
        """
        # --- Attempt 1: Cobalt API ---
        url = await self._resolve_via_cobalt(video_id)
        if url: return url

        # --- Attempt 2: Dynamic Invidious Discovery ---
        url = await self._resolve_via_dynamic_invidious(video_id)
        if url: return url

        # --- Attempt 3: Hardened yt-dlp ---
        return await self._resolve_via_ytdlp(video_id)

    async def _resolve_via_cobalt(self, video_id: str) -> Optional[str]:
        """Uses cobalt.tools public API (Free media extractor)"""
        try:
            import httpx
            # Use multiple public cobalt instances if one is down
            cobalt_instances = ["https://api.cobalt.tools/api/json", "https://cobalt.api.un-known.xyz/api/json"]
            payload = {
                "url": f"https://www.youtube.com/watch?v={video_id}",
                "downloadMode": "audio",
                "audioFormat": "mp3",
                "isNoTTWatermark": True
            }
            async with httpx.AsyncClient(timeout=10.0) as client:
                for api in cobalt_instances:
                    try:
                        resp = await client.post(api, json=payload, headers={"Accept": "application/json"})
                        if resp.status_code == 200:
                            data = resp.json()
                            if data.get("status") in ["stream", "redirect", "success"] and data.get("url"):
                                print(f"DEBUG: Cobalt ({api}) resolved {video_id}")
                                return data["url"]
                    except Exception: continue
        except ImportError: pass
        return None

    async def _resolve_via_dynamic_invidious(self, video_id: str) -> Optional[str]:
        """Fetches healthy Invidious instances dynamically from api.invidious.io"""
        import httpx
        import time

        # Fetch fresh list every 1 hour
        if not self._cached_invidious_instances or (time.time() - self._last_instance_fetch) > 3600:
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    resp = await client.get("https://api.invidious.io/instances.json?sort_by=health")
                    if resp.status_code == 200:
                        instances = resp.json()
                        # Pick top 10 healthy instances that have API enabled
                        self._cached_invidious_instances = [
                            f"https://{item[0]}" for item in instances 
                            if item[1].get('type') == 'https' and item[1].get('health', 0) > 90
                        ][:10]
                        self._last_instance_fetch = time.time()
            except Exception as e:
                print(f"DEBUG: Failed to fetch Invidious list: {e}")
        
        if not self._cached_invidious_instances:
            return None

        # Shuffle to distribute load
        targets = list(self._cached_invidious_instances)
        random.shuffle(targets)

        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            for instance in targets[:3]: # Try top 3 random healthy ones
                try:
                    api_url = f"{instance}/api/v1/videos/{video_id}"
                    resp = await client.get(api_url)
                    if resp.status_code == 200:
                        data = resp.json()
                        audio_formats = [f for f in data.get('adaptiveFormats', []) if 'audio' in f.get('type', '') and f.get('url')]
                        if audio_formats:
                            best = max(audio_formats, key=lambda f: int(f.get('bitrate', 0)))
                            print(f"DEBUG: Invidious ({instance}) resolved {video_id}")
                            return best['url']
                except Exception: continue
        return None

    async def _resolve_via_ytdlp(self, video_id: str) -> Optional[str]:
        loop = asyncio.get_event_loop()
        yt_url = f"https://www.youtube.com/watch?v={video_id}"
        try:
            with yt_dlp.YoutubeDL(self.ydl_resolve_opts) as ydl:
                info = await loop.run_in_executor(None, lambda: ydl.extract_info(yt_url, download=False))
            if not info: return None
            stream_url = info.get('url')
            if stream_url: return stream_url
            formats = info.get('formats', [])
            audio_formats = [f for f in formats if f.get('acodec') != 'none' and f.get('vcodec') == 'none' and f.get('url')]
            if audio_formats:
                best = max(audio_formats, key=lambda f: f.get('abr') or 0)
                return best['url']
        except Exception: pass
        return None

    def _format_duration(self, seconds: Optional[int]) -> str:
        if not seconds: return "0:00"
        try:
            total_seconds = int(seconds)
            return f"{total_seconds // 60}:{total_seconds % 60:02d}"
        except: return "0:00"
