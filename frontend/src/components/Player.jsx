import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

/**
 * Dual player:
 *  - YouTube songs → YouTube IFrame Player (full songs, with video)
 *  - Deezer/iTunes songs → HTML5 <audio> tag (30s previews, background playback via Media Session API)
 */
const Player = forwardRef(({ song, roomId, socket, onSyncEmit, onPlaybackChange, onNext, onPrev, isHost, userId, hostId }, ref) => {
  const audioRef = useRef(null);
  const ytPlayerRef = useRef(null);
  const ytReadyRef = useRef(false);
  const suppressOutgoingRef = useRef(false);
  const loadedSongIdRef = useRef(null);
  const [isYTReady, setIsYTReady] = useState(!!(window.YT && window.YT.Player));

  // Stable refs for callbacks used inside YT player's onStateChange closure
  const onPlaybackChangeRef = useRef(onPlaybackChange);
  const onNextRef = useRef(onNext);
  const isHostRef = useRef(isHost);
  useEffect(() => { onPlaybackChangeRef.current = onPlaybackChange; }, [onPlaybackChange]);
  useEffect(() => { onNextRef.current = onNext; }, [onNext]);
  useEffect(() => { isHostRef.current = isHost; }, [isHost]);

  const isYouTube = song?.source === "youtube";

  // Fix #7: Properly suppress outgoing events with a timer instead of
  // synchronous set/unset which caused echo loops
  const suppressFor = useCallback((ms = 500) => {
    suppressOutgoingRef.current = true;
    setTimeout(() => { suppressOutgoingRef.current = false; }, ms);
  }, []);

  // ── Load YouTube IFrame API script (once) ───────────────────────────
  useEffect(() => {
    if (window.YT && window.YT.Player) {
      setIsYTReady(true);
      return;
    }
    if (document.querySelector('script[src*="youtube.com/iframe_api"]')) return;
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => setIsYTReady(true);
  }, []);

  // ── Imperative controls (called from App.jsx) ───────────────────────
  useImperativeHandle(ref, () => ({
    play: () => {
      if (isYouTube && ytPlayerRef.current?.playVideo) ytPlayerRef.current.playVideo();
      else audioRef.current?.play().catch(() => {});
    },
    pause: () => {
      if (isYouTube && ytPlayerRef.current?.pauseVideo) ytPlayerRef.current.pauseVideo();
      else audioRef.current?.pause();
    },
    syncTo: (timestamp, isPlaying) => {
      suppressFor(500);
      if (isYouTube && ytPlayerRef.current?.seekTo) {
        ytPlayerRef.current.seekTo(timestamp, true);
        if (isPlaying) ytPlayerRef.current.playVideo();
        else ytPlayerRef.current.pauseVideo();
      } else {
        const audio = audioRef.current;
        if (!audio) return;
        audio.currentTime = timestamp;
        if (isPlaying) audio.play().catch(() => {});
        else audio.pause();
      }
    }
  }));

  // ── YouTube: create player once, reuse via loadVideoById ────────────
  useEffect(() => {
    if (!isYTReady || !isYouTube || !song?.songId) return;
    if (loadedSongIdRef.current === song.songId) return;

    const videoId = song.songId.startsWith("yt-") ? song.songId.replace("yt-", "") : song.songId;
    loadedSongIdRef.current = song.songId;
    suppressFor(1500);

    if (ytPlayerRef.current && ytReadyRef.current) {
      // Player already exists — just load a new video
      ytPlayerRef.current.loadVideoById({
        videoId,
        startSeconds: Number(song.timestamp || 0),
      });
    } else if (!ytPlayerRef.current) {
      // First YouTube song — create the player
      ytPlayerRef.current = new window.YT.Player("yt-player", {
        height: "200",
        width: "100%",
        videoId,
        playerVars: {
          autoplay: song.isPlaying ? 1 : 0,
          controls: 1,
          start: Math.floor(Number(song.timestamp || 0)),
        },
        events: {
          onReady: () => { ytReadyRef.current = true; },
          onStateChange: (event) => {
            if (suppressOutgoingRef.current) return;
            const st = event.data;
            const sid = loadedSongIdRef.current;
            if (st === window.YT.PlayerState.PLAYING) {
              onPlaybackChangeRef.current("play", ytPlayerRef.current.getCurrentTime(), sid);
            } else if (st === window.YT.PlayerState.PAUSED) {
              onPlaybackChangeRef.current("pause", ytPlayerRef.current.getCurrentTime(), sid);
            } else if (st === window.YT.PlayerState.ENDED) {
              if (isHostRef.current && onNextRef.current) onNextRef.current();
            }
          },
        },
      });
    }
  }, [isYTReady, isYouTube, song?.songId, suppressFor]);

  // ── Preview: load via <audio> tag ───────────────────────────────────
  useEffect(() => {
    if (!song?.songId || isYouTube) return;
    const audio = audioRef.current;
    if (!audio) return;
    if (loadedSongIdRef.current === song.songId) return;

    loadedSongIdRef.current = song.songId;
    suppressFor(1000);

    if (!song.previewUrl) return;

    audio.src = song.previewUrl;
    // Fix #11: Removed unnecessary audio.load() — setting src already triggers load
    audio.currentTime = Number(song.timestamp || 0);
    if (song.isPlaying) audio.play().catch(() => {});
  }, [song?.songId, song?.source, song?.previewUrl, isYouTube, suppressFor]);

  // ── Pause the inactive player when source type switches ─────────────
  useEffect(() => {
    if (isYouTube) {
      audioRef.current?.pause();
    } else if (ytPlayerRef.current?.pauseVideo && ytReadyRef.current) {
      ytPlayerRef.current.pauseVideo();
    }
  }, [isYouTube]);

  // ── Media Session API — lock-screen controls & background playback ──
  useEffect(() => {
    if (!("mediaSession" in navigator) || !song?.title) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title || "SyncMusic",
      artist: song.artist || "Unknown Artist",
      artwork: song.thumbnail
        ? [
            { src: song.thumbnail, sizes: "96x96", type: "image/jpeg" },
            { src: song.thumbnail, sizes: "256x256", type: "image/jpeg" },
            { src: song.thumbnail, sizes: "512x512", type: "image/jpeg" },
          ]
        : [],
    });

    navigator.mediaSession.setActionHandler("play", () => {
      if (isYouTube && ytPlayerRef.current?.playVideo) ytPlayerRef.current.playVideo();
      else audioRef.current?.play().catch(() => {});
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      if (isYouTube && ytPlayerRef.current?.pauseVideo) ytPlayerRef.current.pauseVideo();
      else audioRef.current?.pause();
    });
    navigator.mediaSession.setActionHandler("nexttrack", onNext || null);
    navigator.mediaSession.setActionHandler("previoustrack", onPrev || null);
  }, [song?.title, song?.artist, song?.thumbnail, onNext, onPrev, isYouTube]);

  // ── Socket sync_time — correct drift between clients ────────────────
  useEffect(() => {
    if (!socket) return;
    const handleSync = ({ timestamp, isPlaying, songId }) => {
      if (songId && songId !== song?.songId) return;

      let currentTime = 0;
      let currentlyPlaying = false;

      if (isYouTube && ytPlayerRef.current && ytReadyRef.current) {
        currentTime = ytPlayerRef.current.getCurrentTime?.() || 0;
        currentlyPlaying = ytPlayerRef.current.getPlayerState?.() === window.YT?.PlayerState?.PLAYING;
      } else if (audioRef.current) {
        currentTime = audioRef.current.currentTime || 0;
        currentlyPlaying = !audioRef.current.paused;
      }

      const timeDiff = Math.abs(currentTime - timestamp);
      const playStateChanged = isPlaying !== currentlyPlaying;

      if (timeDiff > 1.2 || playStateChanged) {
        suppressFor(300);
        if (isYouTube && ytPlayerRef.current && ytReadyRef.current) {
          if (timeDiff > 1.2) ytPlayerRef.current.seekTo(timestamp, true);
          if (isPlaying) ytPlayerRef.current.playVideo();
          else ytPlayerRef.current.pauseVideo();
        } else {
          const audio = audioRef.current;
          if (!audio) return;
          if (timeDiff > 1.2) audio.currentTime = timestamp;
          if (isPlaying) audio.play().catch(() => {});
          else audio.pause();
        }
      }
    };
    socket.on("sync_time", handleSync);
    return () => socket.off("sync_time", handleSync);
  }, [socket, song?.songId, isYouTube, suppressFor]);

  // ── Fix #6: Heartbeat reduced from 5s to 2s ────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      const isHostLocal = hostId === userId;
      if (!isHostLocal || !roomId || suppressOutgoingRef.current || !song?.songId) return;

      let timestamp = 0;
      let isPlaying = false;

      if (isYouTube && ytPlayerRef.current && ytReadyRef.current) {
        timestamp = ytPlayerRef.current.getCurrentTime?.() || 0;
        isPlaying = ytPlayerRef.current.getPlayerState?.() === window.YT?.PlayerState?.PLAYING;
      } else if (audioRef.current) {
        timestamp = audioRef.current.currentTime || 0;
        isPlaying = !audioRef.current.paused;
      }

      onSyncEmit(timestamp, isPlaying, song.songId);
    }, 2000);
    return () => clearInterval(interval);
  }, [roomId, onSyncEmit, song?.songId, hostId, userId, isYouTube]);

  // ── Audio event handlers (preview songs only) ───────────────────────
  useEffect(() => {
    if (isYouTube) return;
    const audio = audioRef.current;
    if (!audio) return;

    const onEnded = () => { if (isHost && onNext) onNext(); };
    const onPlay = () => { if (!suppressOutgoingRef.current) onPlaybackChange("play", audio.currentTime, song?.songId); };
    const onPause = () => { if (!suppressOutgoingRef.current) onPlaybackChange("pause", audio.currentTime, song?.songId); };

    audio.addEventListener("ended", onEnded);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);

    return () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
    };
  }, [onPlaybackChange, isHost, onNext, song?.songId, isYouTube]);

  return (
    <div className="player-card">
      <div className="player-hero">
        <div
          className="album-art-wrap"
          style={isYouTube
            ? { width: "100%", aspectRatio: "16/9", position: "relative" }
            : { width: "100%", height: "200px", position: "relative" }
          }
        >
          {/* YouTube player — always in DOM, hidden when preview */}
          <div style={{ display: isYouTube ? "block" : "none", width: "100%", height: "100%", borderRadius: "12px", overflow: "hidden" }}>
            <div id="yt-player" />
          </div>

          {/* Preview album art */}
          {!isYouTube && (
            song?.thumbnail
              ? <img className="album-art" src={song.thumbnail} alt={song.title} style={{ width: "100%", height: "100%", borderRadius: "12px", objectFit: "cover" }} />
              : <div className="album-art album-art--empty"><span>♪</span></div>
          )}
        </div>

        <div className="player-meta" style={{ marginTop: "16px", textAlign: "center" }}>
          <div className="player-title" style={{ fontSize: "1.2rem", fontWeight: "bold" }}>{song?.title || "Nothing playing"}</div>
          <div className="player-artist" style={{ color: "#777" }}>{song?.artist || "Add a song to begin"}</div>
          <div className="source-badge" style={{ marginTop: "8px", display: "inline-block", padding: "2px 8px", background: "#333", borderRadius: "5px", fontSize: "0.7rem" }}>
            {song?.source === "youtube" ? "YouTube Full" : song?.source === "deezer" ? "Deezer Preview" : song?.source === "itunes" ? "iTunes Preview" : "Preview"}
          </div>
        </div>
      </div>

      {/* Audio player for preview songs */}
      <audio
        ref={audioRef}
        controls
        className="audio-player"
        style={{ width: "100%", marginTop: "16px", display: isYouTube ? "none" : "block" }}
      />
    </div>
  );
});

Player.displayName = "Player";
export default Player;