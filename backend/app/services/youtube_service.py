import asyncio
import random
import re
import time
from typing import Any, Optional
import yt_dlp
from ytmusicapi import YTMusic

class YouTubeService:
    def __init__(self):
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
        self._piped_instances = ["https://pipedapi.kavin.rocks", "https://pipedapi.colby.cloud", "https://api.piped.yt"]

    # ------------------------------------------------------------------ #
    #  Ultimate Resilient Stream Resolution (The Nuclear Option)          #
    # ------------------------------------------------------------------ #

    async def resolve_url(self, video_id: str) -> Optional[str]:
        print(f"--- RESOLVE START: {video_id} ---")
        
        # 1. Try Piped API (Fastest & often works on cloud)
        url = await self._resolve_via_piped(video_id)
        if url: return url

        # 2. Try Cobalt API (High reliability media proxy)
        url = await self._resolve_via_cobalt(video_id)
        if url: return url

        # 3. Try Dynamic Invidious Discovery
        url = await self._resolve_via_dynamic_invidious(video_id)
        if url: return url

        # 4. Try Hardened yt-dlp
        url = await self._resolve_via_ytdlp(video_id)
        if url: return url

        print(f"--- RESOLVE FAILED: {video_id} (All methods exhausted) ---")
        return None

    async def _resolve_via_piped(self, video_id: str) -> Optional[str]:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=10.0) as client:
                for api in self._piped_instances:
                    try:
                        resp = await client.get(f"{api}/streams/{video_id}")
                        if resp.status_code == 200:
                            data = resp.json()
                            audio_streams = data.get("audioStreams", [])
                            if audio_streams:
                                # Pick highest quality available
                                best = max(audio_streams, key=lambda s: s.get("bitrate", 0))
                                print(f"STAGE SUCCESS: Piped ({api}) resolved {video_id}")
                                return best["url"]
                    except Exception: continue
        except Exception as e: print(f"STAGE FAIL: Piped error: {e}")
        return None

    async def _resolve_via_cobalt(self, video_id: str) -> Optional[str]:
        try:
            import httpx
            cobalt_instances = ["https://api.cobalt.tools/api/json", "https://cobalt.api.un-known.xyz/api/json"]
            payload = {"url": f"https://www.youtube.com/watch?v={video_id}", "downloadMode": "audio"}
            async with httpx.AsyncClient(timeout=10.0) as client:
                for api in cobalt_instances:
                    try:
                        resp = await client.post(api, json=payload, headers={"Accept": "application/json"})
                        if resp.status_code == 200:
                            data = resp.json()
                            if data.get("url"):
                                print(f"STAGE SUCCESS: Cobalt ({api}) resolved {video_id}")
                                return data["url"]
                        else:
                            print(f"STAGE LOG: Cobalt ({api}) returned {resp.status_code}")
                    except Exception: continue
        except Exception as e: print(f"STAGE FAIL: Cobalt error: {e}")
        return None

    async def _resolve_via_dynamic_invidious(self, video_id: str) -> Optional[str]:
        import httpx
        if not self._cached_invidious_instances or (time.time() - self._last_instance_fetch) > 3600:
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    resp = await client.get("https://api.invidious.io/instances.json?sort_by=health")
                    if resp.status_code == 200:
                        instances = resp.json()
                        self._cached_invidious_instances = [f"https://{item[0]}" for item in instances if item[1].get('type') == 'https' and item[1].get('health', 0) > 90][:10]
                        self._last_instance_fetch = time.time()
            except Exception: pass
        
        if not self._cached_invidious_instances: return None
        targets = list(self._cached_invidious_instances)
        random.shuffle(targets)

        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            for instance in targets[:3]:
                try:
                    resp = await client.get(f"{instance}/api/v1/videos/{video_id}")
                    if resp.status_code == 200:
                        data = resp.json()
                        audio_formats = [f for f in data.get('adaptiveFormats', []) if 'audio' in f.get('type', '')]
                        if audio_formats:
                            best = max(audio_formats, key=lambda f: int(f.get('bitrate', 0)))
                            print(f"STAGE SUCCESS: Invidious ({instance}) resolved {video_id}")
                            return best['url']
                except Exception: continue
        return None

    async def _resolve_via_ytdlp(self, video_id: str) -> Optional[str]:
        loop = asyncio.get_event_loop()
        try:
            with yt_dlp.YoutubeDL(self.ydl_resolve_opts) as ydl:
                info = await loop.run_in_executor(None, lambda: ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False))
            if info:
                url = info.get('url') or info.get('formats', [{}])[0].get('url')
                if url:
                    print(f"STAGE SUCCESS: yt-dlp resolved {video_id}")
                    return url
        except Exception as e: print(f"STAGE FAIL: yt-dlp error: {e}")
        return None

    # ... Rest of the search/helper methods remain the same ...
    async def search_youtube(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        loop = asyncio.get_event_loop()
        try:
            search_results = await loop.run_in_executor(None, lambda: self.ytmusic.search(query, filter="songs", limit=limit))
            results = []
            for item in search_results:
                video_id = item.get('videoId')
                if not video_id: continue
                results.append({
                    "songId": f"yt-{video_id}", "title": item.get('title', 'Unknown'), "artist": item.get('artists', [{}])[0].get('name', 'Unknown'),
                    "thumbnail": item.get('thumbnails', [{}])[-1].get('url', ''), "duration": item.get('duration', '0:00'),
                    "durationSec": item.get('duration_seconds', 0), "previewUrl": "", "source": "youtube"
                })
            return results
        except Exception: return []

    def _format_duration(self, seconds: Optional[int]) -> str:
        if not seconds: return "0:00"
        return f"{int(seconds) // 60}:{int(seconds) % 60:02d}"
