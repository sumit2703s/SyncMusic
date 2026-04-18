"""
YouTube Service — Multi-layer stream resolution
================================================
Layer 1: Piped API          (fastest, no yt-dlp needed, works on cloud)
Layer 2: Invidious API      (dynamic instance discovery, good fallback)
Layer 3: yt-dlp po_token    (uses tv_embedded which is least blocked)
Layer 4: yt-dlp web         (last resort)

Search: ytmusicapi → yt-dlp fallback
"""

import asyncio
import random
import time
from typing import Any, Optional

import yt_dlp
from ytmusicapi import YTMusic


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PIPED_INSTANCES = [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.colby.cloud",
    "https://api.piped.yt",
    "https://piped-api.garudalinux.org",
]

HARDCODED_INVIDIOUS = [
    "https://invidious.nerdvpn.de",
    "https://iv.datura.network",
    "https://invidious.privacyredirect.com",
    "https://invidious.fdn.fr",
]

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

class YouTubeService:
    def __init__(self):
        # Search opts — extract_flat=True, no stream URL needed
        self.ydl_search_opts = {
            "format": "bestaudio[ext=m4a]/bestaudio/best",
            "quiet": True,
            "no_warnings": True,
            "extract_flat": True,
            "skip_download": True,
            "nocheckcertificate": True,
            "ignoreerrors": True,
        }

        # Resolve opts — tv_embedded client is least restricted on server IPs
        self.ydl_resolve_opts_tv = {
            "format": "bestaudio[ext=m4a]/bestaudio/best",
            "quiet": True,
            "no_warnings": True,
            "extract_flat": False,
            "skip_download": True,
            "nocheckcertificate": True,
            "ignoreerrors": False,
            "http_headers": BROWSER_HEADERS,
            "extractor_args": {
                "youtube": {
                    "player_client": ["tv_embedded"],
                    "skip": ["hls", "dash"],
                }
            },
        }

        # Web client fallback
        self.ydl_resolve_opts_web = {
            **self.ydl_resolve_opts_tv,
            "extractor_args": {
                "youtube": {
                    "player_client": ["web"],
                    "skip": ["hls", "dash"],
                }
            },
        }

        self.ytmusic = YTMusic()
        self._invidious_cache: list[str] = []
        self._invidious_fetched_at: float = 0

    # -----------------------------------------------------------------------
    # Public: Search
    # -----------------------------------------------------------------------

    async def search_youtube(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        loop = asyncio.get_event_loop()
        try:
            results = await loop.run_in_executor(
                None, lambda: self.ytmusic.search(query, filter="songs", limit=limit)
            )
            out = []
            for item in results:
                vid = item.get("videoId")
                if not vid:
                    continue
                artists = item.get("artists", [])
                thumbs = item.get("thumbnails", [])
                out.append({
                    "songId": f"yt-{vid}",
                    "title": item.get("title", "Unknown"),
                    "artist": artists[0].get("name", "Unknown") if artists else "Unknown",
                    "thumbnail": thumbs[-1].get("url", "") if thumbs else "",
                    "duration": item.get("duration", "0:00"),
                    "durationSec": item.get("duration_seconds", 0),
                    "previewUrl": "",
                    "source": "youtube",
                })
            return out
        except Exception as e:
            print(f"YTMusic search error: {e}")
            return await self._fallback_search(query, limit)

    async def _fallback_search(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        loop = asyncio.get_event_loop()
        try:
            with yt_dlp.YoutubeDL(self.ydl_search_opts) as ydl:
                info = await loop.run_in_executor(
                    None, lambda: ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
                )
            out = []
            for e in (info.get("entries") or []):
                if not e:
                    continue
                thumbs = e.get("thumbnails") or [{}]
                out.append({
                    "songId": f"yt-{e['id']}",
                    "title": e.get("title", "Unknown"),
                    "artist": e.get("uploader", "Unknown"),
                    "thumbnail": thumbs[-1].get("url", ""),
                    "duration": self._fmt(e.get("duration", 0)),
                    "durationSec": e.get("duration", 0),
                    "previewUrl": "",
                    "source": "youtube",
                })
            return out
        except Exception as e:
            print(f"Fallback search error: {e}")
            return []

    # -----------------------------------------------------------------------
    # Public: Resolve stream URL
    # -----------------------------------------------------------------------

    async def resolve_url(self, video_id: str) -> Optional[str]:
        """
        Try every layer in order. Return the first working audio URL.
        Layers run concurrently where possible to reduce latency.
        """
        print(f"[RESOLVE] Starting for {video_id}")

        # Layer 1 + 2 in parallel (both are HTTP, fast)
        piped_task = asyncio.create_task(self._via_piped(video_id))
        invidious_task = asyncio.create_task(self._via_invidious(video_id))

        # Wait for Piped first (usually fastest)
        piped_url = await piped_task
        if piped_url:
            invidious_task.cancel()
            print(f"[RESOLVE] Piped success: {video_id}")
            return piped_url

        invidious_url = await invidious_task
        if invidious_url:
            print(f"[RESOLVE] Invidious success: {video_id}")
            return invidious_url

        # Layer 3: yt-dlp tv_embedded
        url = await self._via_ytdlp(video_id, self.ydl_resolve_opts_tv, "tv_embedded")
        if url:
            return url

        # Layer 4: yt-dlp web client
        url = await self._via_ytdlp(video_id, self.ydl_resolve_opts_web, "web")
        if url:
            return url

        print(f"[RESOLVE] ALL LAYERS FAILED for {video_id}")
        return None

    # -----------------------------------------------------------------------
    # Layer 1: Piped
    # -----------------------------------------------------------------------

    async def _via_piped(self, video_id: str) -> Optional[str]:
        try:
            import httpx
            instances = PIPED_INSTANCES.copy()
            random.shuffle(instances)
            async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
                for api in instances:
                    try:
                        resp = await client.get(f"{api}/streams/{video_id}")
                        if resp.status_code != 200:
                            continue
                        data = resp.json()
                        streams = data.get("audioStreams", [])
                        if streams:
                            best = max(streams, key=lambda s: s.get("bitrate", 0))
                            url = best.get("url")
                            if url:
                                print(f"[PIPED] OK via {api}")
                                return url
                    except Exception:
                        continue
        except Exception as e:
            print(f"[PIPED] Error: {e}")
        return None

    # -----------------------------------------------------------------------
    # Layer 2: Invidious (dynamic discovery + hardcoded fallback)
    # -----------------------------------------------------------------------

    async def _via_invidious(self, video_id: str) -> Optional[str]:
        try:
            import httpx
            instances = await self._get_invidious_instances()

            async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
                for instance in instances[:5]:
                    try:
                        resp = await client.get(f"{instance}/api/v1/videos/{video_id}")
                        if resp.status_code != 200:
                            continue
                        data = resp.json()
                        audio_formats = [
                            f for f in data.get("adaptiveFormats", [])
                            if "audio" in f.get("type", "") and f.get("url")
                        ]
                        if audio_formats:
                            best = max(audio_formats, key=lambda f: int(f.get("bitrate", 0)))
                            print(f"[INVIDIOUS] OK via {instance}")
                            return best["url"]
                    except Exception:
                        continue
        except Exception as e:
            print(f"[INVIDIOUS] Error: {e}")
        return None

    async def _get_invidious_instances(self) -> list[str]:
        """Fetch healthy Invidious instances, cached for 1 hour."""
        now = time.time()
        if self._invidious_cache and (now - self._invidious_fetched_at) < 3600:
            return self._invidious_cache

        try:
            import httpx
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get("https://api.invidious.io/instances.json?sort_by=health")
                if resp.status_code == 200:
                    data = resp.json()
                    instances = [
                        f"https://{item[0]}"
                        for item in data
                        if item[1].get("type") == "https" and item[1].get("health", 0) > 80
                    ][:8]
                    if instances:
                        self._invidious_cache = instances
                        self._invidious_fetched_at = now
                        return instances
        except Exception:
            pass

        # Fallback to hardcoded list
        shuffled = HARDCODED_INVIDIOUS.copy()
        random.shuffle(shuffled)
        return shuffled

    # -----------------------------------------------------------------------
    # Layer 3 & 4: yt-dlp
    # -----------------------------------------------------------------------

    async def _via_ytdlp(self, video_id: str, opts: dict, label: str) -> Optional[str]:
        loop = asyncio.get_event_loop()
        yt_url = f"https://www.youtube.com/watch?v={video_id}"
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = await loop.run_in_executor(
                    None, lambda: ydl.extract_info(yt_url, download=False)
                )
            if not info:
                return None

            # Direct URL
            if info.get("url"):
                print(f"[YTDLP/{label}] OK via direct url")
                return info["url"]

            # Best audio-only format
            formats = info.get("formats") or []
            audio = [
                f for f in formats
                if f.get("acodec") != "none"
                and f.get("vcodec") in (None, "none", "")
                and f.get("url")
            ]
            if audio:
                best = max(audio, key=lambda f: f.get("abr") or 0)
                print(f"[YTDLP/{label}] OK via formats")
                return best["url"]

            print(f"[YTDLP/{label}] No usable URL found")
        except Exception as e:
            print(f"[YTDLP/{label}] Error: {e}")
        return None

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    def _fmt(self, seconds: Optional[int]) -> str:
        if not seconds:
            return "0:00"
        try:
            s = int(seconds)
            return f"{s // 60}:{s % 60:02d}"
        except (ValueError, TypeError):
            return "0:00"