from typing import Any
import httpx


class MusicService:
    @staticmethod
    def _format_duration(seconds: int) -> str:
        minutes = seconds // 60
        remaining = seconds % 60
        return f"{minutes}:{remaining:02d}"

    async def search_songs(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        """
        Search songs using Deezer as primary and iTunes as fallback.
        """
        songs = await self._search_deezer(query, limit)
        if not songs:
            print(f"No Deezer results for '{query}', trying iTunes fallback...")
            songs = await self._search_itunes(query, limit)
        
        return songs

    async def _search_deezer(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        url = "https://api.deezer.com/search"
        params = {"q": query}
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        }
        
        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                response = await client.get(url, params=params, headers=headers)
                response.raise_for_status()
                payload = response.json()

            rows = payload.get("data", [])[:limit]
            songs: list[dict] = []
            for item in rows:
                preview_url = item.get("preview")
                if not preview_url:
                    continue

                duration_seconds = int(item.get("duration", 30))
                song_id = str(item.get("id", ""))
                if not song_id:
                    continue
                album = item.get("album", {}) or {}
                artist = item.get("artist", {}) or {}

                songs.append(
                    {
                        "songId": f"dz-{song_id}",
                        "title": item.get("title", "Unknown Title"),
                        "artist": artist.get("name", "Unknown Artist"),
                        "thumbnail": album.get("cover_medium", ""),
                        "duration": self._format_duration(duration_seconds),
                        "durationSec": duration_seconds,
                        "previewUrl": preview_url,
                        "source": "deezer"
                    }
                )
            return songs
        except Exception as e:
            print(f"Deezer search error: {e}")
            return []

    async def _search_itunes(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        url = "https://itunes.apple.com/search"
        params = {
            "term": query,
            "entity": "song",
            "limit": limit
        }
        
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(url, params=params)
                response.raise_for_status()
                payload = response.json()

            rows = payload.get("results", [])
            songs: list[dict] = []
            for item in rows:
                preview_url = item.get("previewUrl")
                if not preview_url:
                    continue

                duration_ms = item.get("trackTimeMillis", 30000)
                duration_seconds = duration_ms // 1000
                song_id = str(item.get("trackId", ""))
                if not song_id:
                    continue

                songs.append(
                    {
                        "songId": f"it-{song_id}",
                        "title": item.get("trackName", "Unknown Title"),
                        "artist": item.get("artistName", "Unknown Artist"),
                        "thumbnail": item.get("artworkUrl100", "").replace("100x100", "400x400"),
                        "duration": self._format_duration(duration_seconds),
                        "durationSec": duration_seconds,
                        "previewUrl": preview_url,
                        "source": "itunes"
                    }
                )
            return songs
        except Exception as e:
            print(f"iTunes search error: {e}")
            return []
