import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { resolveSong } from "../services/api";

/**
 * Unified audio player — ALL sources (YouTube, Deezer, iTunes) play through
 * the HTML5 <audio> tag. YouTube songs are resolved to audio-only URLs via
 * the backend Piped/Invidious/yt-dlp pipeline.
 *
 * This enables:
 *  - Background playback on Desktop & Android Chrome (via Media Session API)
 *  - Consistent sync behavior across all sources
 *  - Simpler code (no YouTube IFrame API)
 */
const Player = forwardRef(({ song, roomId, socket, onSyncEmit, onPlaybackChange, onNext, onPrev, isHost, userId, hostId }, ref) => {
  const audioRef = useRef(null);
  const suppressOutgoingRef = useRef(false);
  const loadedSongIdRef = useRef(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState("");

  // Fix #7: Properly suppress outgoing events with a timer to avoid race conditions.
  // The old code set suppressOutgoingRef = true then immediately = false (synchronous),
  // so async events fired by seek/play were never actually suppressed.
  const suppressFor = useCallback((ms = 500) => {
    suppressOutgoingRef.current = true;
    setTimeout(() => { suppressOutgoingRef.current = false; }, ms);
  }, []);

  useImperativeHandle(ref, () => ({
    play: () => {
      audioRef.current?.play().catch(() => {});
    },
    pause: () => {
      audioRef.current?.pause();
    },
    syncTo: (timestamp, isPlaying) => {
      const audio = audioRef.current;
      if (!audio) return;
      suppressFor(500);
      audio.currentTime = timestamp;
      if (isPlaying) audio.play().catch(() => {});
      else audio.pause();
    }
  }));

  // ── Load song when songId changes (unified for all sources) ─────────
  useEffect(() => {
    if (!song?.songId) return;
    const audio = audioRef.current;
    if (!audio) return;

    // Skip if this song is already loaded
    if (loadedSongIdRef.current === song.songId) return;

    let cancelled = false;

    const loadSong = async () => {
      loadedSongIdRef.current = song.songId;
      suppressFor(1500);

      let audioUrl = song.previewUrl;

      // For YouTube songs, resolve the audio stream URL via backend
      if (song.source === "youtube") {
        setResolving(true);
        setResolveError("");
        try {
          audioUrl = await resolveSong(song.songId);
        } catch (err) {
          if (!cancelled) {
            setResolveError("Failed to load audio. Try another song.");
            setResolving(false);
          }
          return;
        }
        if (!cancelled) setResolving(false);
      }

      if (cancelled) return;

      if (!audioUrl) {
        setResolveError("No audio URL available for this song.");
        return;
      }

      setResolveError("");
      audio.src = audioUrl;
      // Fix #11: Removed unnecessary audio.load() — setting src already triggers load
      audio.currentTime = Number(song.timestamp || 0);
      if (song.isPlaying) audio.play().catch(() => {});
    };

    loadSong();
    return () => { cancelled = true; };
  }, [song?.songId, song?.source, song?.previewUrl, suppressFor]);

  // ── Media Session API — enables background playback ─────────────────
  // Works on Desktop Chrome, Android Chrome, and partially on other browsers.
  // Provides lock-screen / notification controls on mobile.
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
      audioRef.current?.play().catch(() => {});
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      audioRef.current?.pause();
    });
    navigator.mediaSession.setActionHandler("nexttrack", onNext || null);
    navigator.mediaSession.setActionHandler("previoustrack", onPrev || null);
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (audioRef.current && details.seekTime != null) {
        audioRef.current.currentTime = details.seekTime;
      }
    });
  }, [song?.title, song?.artist, song?.thumbnail, onNext, onPrev]);

  // ── Socket sync_time handler — correct drift between clients ────────
  useEffect(() => {
    if (!socket) return;
    const handleSync = ({ timestamp, isPlaying, songId }) => {
      if (songId && songId !== song?.songId) return;
      const audio = audioRef.current;
      if (!audio) return;

      const current = audio.currentTime || 0;
      const timeDiff = Math.abs(current - timestamp);
      const playStateChanged = isPlaying !== !audio.paused;

      // Sync if time drifted > 1.2s OR play/pause state changed
      if (timeDiff > 1.2 || playStateChanged) {
        suppressFor(300);
        if (timeDiff > 1.2) audio.currentTime = timestamp;
        if (isPlaying) audio.play().catch(() => {});
        else audio.pause();
      }
    };
    socket.on("sync_time", handleSync);
    return () => socket.off("sync_time", handleSync);
  }, [socket, song?.songId, suppressFor]);

  // ── Fix #6: Heartbeat reduced from 5s to 2s for tighter sync ────────
  useEffect(() => {
    const interval = setInterval(() => {
      const isHostLocal = hostId === userId;
      if (!isHostLocal || !roomId || suppressOutgoingRef.current || !song?.songId) return;

      const audio = audioRef.current;
      if (!audio) return;

      const timestamp = audio.currentTime || 0;
      const isPlaying = !audio.paused;
      onSyncEmit(timestamp, isPlaying, song.songId);
    }, 2000);
    return () => clearInterval(interval);
  }, [roomId, onSyncEmit, song?.songId, hostId, userId]);

  // ── Audio element event handlers ────────────────────────────────────
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onDurationChange = () => setDuration(audio.duration || 0);
    const onEnded = () => { if (isHost && onNext) onNext(); };
    const onPlay = () => { if (!suppressOutgoingRef.current) onPlaybackChange("play", audio.currentTime, song?.songId); };
    const onPause = () => { if (!suppressOutgoingRef.current) onPlaybackChange("pause", audio.currentTime, song?.songId); };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
    };
  }, [onPlaybackChange, isHost, onNext, song?.songId]);

  return (
    <div className="player-card">
      <div className="player-hero">
        <div className="album-art-wrap" style={{ width: "100%", height: "200px", position: "relative" }}>
          {resolving && (
            <div className="album-art-overlay">
              <div className="spinner" />
            </div>
          )}
          {song?.thumbnail
            ? <img className="album-art" src={song.thumbnail} alt={song.title} style={{ width: "100%", height: "100%", borderRadius: "12px", objectFit: "cover" }} />
            : <div className="album-art album-art--empty"><span>♪</span></div>
          }
        </div>

        <div className="player-meta" style={{ marginTop: "16px", textAlign: "center" }}>
          <div className="player-title" style={{ fontSize: "1.2rem", fontWeight: "bold" }}>{song?.title || "Nothing playing"}</div>
          <div className="player-artist" style={{ color: "#777" }}>{song?.artist || "Add a song to begin"}</div>
          <div className="source-badge" style={{ marginTop: "8px", display: "inline-block", padding: "2px 8px", background: "#333", borderRadius: "5px", fontSize: "0.7rem" }}>
            {song?.source === "youtube" ? "YouTube Full" : song?.source === "deezer" ? "Deezer Preview" : song?.source === "itunes" ? "iTunes Preview" : "Preview"}
          </div>
        </div>
      </div>

      {resolveError && <div className="player-error">{resolveError}</div>}

      <audio ref={audioRef} controls className="audio-player" style={{ width: "100%", marginTop: "16px" }} />
    </div>
  );
});

Player.displayName = "Player";
export default Player;