import asyncio
import re
from typing import Any, Optional
import yt_dlp
from ytmusicapi import YTMusic


# Public Invidious instances to use as fallback proxy
INVIDIOUS_INSTANCES = [
    "https://invidious.nerdvpn.de",
    "https://iv.datura.network",
    "https://invidious.privacyredirect.com",
]


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
            'extract_flat': False,   # <-- Must be False to get real stream URL
            'skip_download': True,
            'nocheckcertificate': True,
            'ignoreerrors': False,
            'logtostderr': False,
            # tv_embedded and mweb clients are far less blocked on server IPs
            'extractor_args': {
                'youtube': {
                    'player_client': ['tv_embedded', 'mweb'],
                    'skip': ['hls', 'dash'],
                }
            },
            # Mimic a real browser request
            'http_headers': {
                'User-Agent': (
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                    'AppleWebKit/537.36 (KHTML, like Gecko) '
                    'Chrome/124.0.0.0 Safari/537.36'
                ),
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
        }

        self.ytmusic = YTMusic()

    # ------------------------------------------------------------------ #
    #  Search                                                              #
    # ------------------------------------------------------------------ #

    async def search_youtube(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        """Search YouTube Music (songs filter). Falls back to yt-dlp search."""
        loop = asyncio.get_event_loop()

        try:
            search_results = await loop.run_in_executor(
                None,
                lambda: self.ytmusic.search(query, filter="songs", limit=limit)
            )

            results = []
            for item in search_results:
                video_id = item.get('videoId')
                if not video_id:
                    continue

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

        except Exception as e:
            print(f"YouTube Music search error: {e}")
            return await self._fallback_search(query, limit)

    async def _fallback_search(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        loop = asyncio.get_event_loop()
        search_query = f"ytsearch{limit}:{query} music"

        try:
            with yt_dlp.YoutubeDL(self.ydl_search_opts) as ydl:
                info = await loop.run_in_executor(
                    None, lambda: ydl.extract_info(search_query, download=False)
                )

            entries = info.get('entries', []) if info else []
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

    # ------------------------------------------------------------------ #
    #  Stream URL Resolution                                               #
    # ------------------------------------------------------------------ #

    async def resolve_url(self, video_id: str) -> Optional[str]:
        """
        Try to get a playable audio URL for a YouTube video.
        Strategy:
          1. yt-dlp with tv_embedded + mweb clients (works on most servers)
          2. Public Invidious API (proxy fallback — no yt-dlp needed)
        """
        # --- Attempt 1: yt-dlp ---
        url = await self._resolve_via_ytdlp(video_id)
        if url:
            return url

        print(f"DEBUG: yt-dlp failed for {video_id}, trying Invidious fallback...")

        # --- Attempt 2: Invidious public API ---
        url = await self._resolve_via_invidious(video_id)
        if url:
            return url

        print(f"DEBUG: All resolution methods failed for {video_id}")
        return None

    async def _resolve_via_ytdlp(self, video_id: str) -> Optional[str]:
        loop = asyncio.get_event_loop()
        yt_url = f"https://www.youtube.com/watch?v={video_id}"

        try:
            with yt_dlp.YoutubeDL(self.ydl_resolve_opts) as ydl:
                info = await loop.run_in_executor(
                    None, lambda: ydl.extract_info(yt_url, download=False)
                )

            if not info:
                print(f"DEBUG: yt-dlp returned no info for {video_id}")
                return None

            # Prefer a direct URL on the top-level info dict
            stream_url = info.get('url')
            if stream_url:
                print(f"DEBUG: yt-dlp resolved URL for {video_id}")
                return stream_url

            # Some formats are nested under 'formats'
            formats = info.get('formats', [])
            audio_formats = [
                f for f in formats
                if f.get('acodec') != 'none' and f.get('vcodec') == 'none' and f.get('url')
            ]
            if audio_formats:
                # Pick highest quality audio-only format
                best = max(audio_formats, key=lambda f: f.get('abr') or 0)
                print(f"DEBUG: yt-dlp resolved format URL for {video_id}")
                return best['url']

            print(f"DEBUG: yt-dlp info had no usable URL. Keys: {list(info.keys())}")
            return None

        except Exception as e:
            print(f"yt-dlp resolution error for {video_id}: {e}")
            return None

    async def _resolve_via_invidious(self, video_id: str) -> Optional[str]:
        """
        Use public Invidious instances to get an audio stream URL.
        Invidious acts as a YouTube proxy — no API key needed.
        """
        try:
            import httpx
        except ImportError:
            print("httpx not installed, skipping Invidious fallback")
            return None

        for instance in INVIDIOUS_INSTANCES:
            try:
                api_url = f"{instance}/api/v1/videos/{video_id}"
                async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                    resp = await client.get(api_url)

                if resp.status_code != 200:
                    print(f"DEBUG: Invidious {instance} returned {resp.status_code}")
                    continue

                data = resp.json()
                audio_formats = [
                    f for f in data.get('adaptiveFormats', [])
                    if 'audio' in f.get('type', '') and f.get('url')
                ]

                if not audio_formats:
                    continue

                # Pick highest bitrate
                best = max(audio_formats, key=lambda f: int(f.get('bitrate', 0)))
                stream_url = best['url']
                print(f"DEBUG: Invidious ({instance}) resolved URL for {video_id}")
                return stream_url

            except Exception as e:
                print(f"DEBUG: Invidious {instance} error: {e}")
                continue

        return None

    # ------------------------------------------------------------------ #
    #  Helpers                                                             #
    # ------------------------------------------------------------------ #

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
