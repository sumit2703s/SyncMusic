import { forwardRef, useEffect, useImperativeHandle, useRef, useState, useCallback } from "react";
import { resolveSong } from "../services/api";

const Player = forwardRef(({ song, roomId, socket, onSyncEmit, onPlaybackChange, onSongReplace, onNext, isHost }, ref) => {
  const audioRef = useRef(null);
  const suppressEmitRef = useRef(false);
  const loadedSongIdRef = useRef(null);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

  useImperativeHandle(ref, () => ({
    play: () => audioRef.current?.play().catch(() => { }),
    pause: () => audioRef.current?.pause(),
  }));

  // ── Load new song ────────────────────────────────────────────────────
  useEffect(() => {
    if (!song?.songId || !audioRef.current) return;

    // Same song already loaded — just sync state
    if (loadedSongIdRef.current === song.songId) {
      const audio = audioRef.current;
      const diff = Math.abs(audio.currentTime - Number(song.timestamp || 0));
      if (diff > 2.0) {
        suppressEmitRef.current = true;
        audio.currentTime = Number(song.timestamp || 0);
        setTimeout(() => { suppressEmitRef.current = false; }, 500);
      }
      if (song.isPlaying && audio.paused) audio.play().catch(() => { });
      else if (!song.isPlaying && !audio.paused) audio.pause();
      return;
    }

    const loadSong = async () => {
      // Preview songs have a direct URL
      let finalUrl = song.previewUrl || "";

      // YouTube songs: resolve full stream URL from backend
      if (song.source === "youtube" && !finalUrl) {
        setResolving(true);
        setError("");
        try {
          finalUrl = await resolveSong(song.songId);
          if (!finalUrl) throw new Error("Could not resolve stream");
        } catch (err) {
          console.error("Stream resolution failed:", err);
          setError("Could not load this track. Try another song.");
          setResolving(false);
          return;
        } finally {
          setResolving(false);
        }
      }

      if (!finalUrl || !audioRef.current) return;

      const audio = audioRef.current;
      loadedSongIdRef.current = song.songId;
      setError("");
      suppressEmitRef.current = true;

      audio.src = finalUrl;
      audio.currentTime = Number(song.timestamp || 0);
      audio.volume = isMuted ? 0 : volume;
      audio.load();

      if (song.isPlaying) {
        audio.play().catch((e) => console.warn("Autoplay blocked:", e));
      }

      setTimeout(() => { suppressEmitRef.current = false; }, 1500);
    };

    loadSong();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.songId, song?.previewUrl, song?.source]);

  // ── Sync play/pause ───────────────────────────────────────────────────
  useEffect(() => {
    if (!audioRef.current || !song?.songId || loadedSongIdRef.current !== song.songId) return;
    suppressEmitRef.current = true;
    if (song.isPlaying) audioRef.current.play().catch(() => { });
    else audioRef.current.pause();
    setTimeout(() => { suppressEmitRef.current = false; }, 500);
  }, [song?.isPlaying]);

  // ── Seek sync ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!audioRef.current || !song?.songId || loadedSongIdRef.current !== song.songId) return;
    const diff = Math.abs(audioRef.current.currentTime - Number(song.timestamp || 0));
    if (diff > 2.0) {
      suppressEmitRef.current = true;
      audioRef.current.currentTime = Number(song.timestamp || 0);
      setTimeout(() => { suppressEmitRef.current = false; }, 500);
    }
  }, [song?.timestamp]);

  // ── Audio element events ──────────────────────────────────────────────
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlay = () => { if (!suppressEmitRef.current) onPlaybackChange("play", audio.currentTime, song?.songId); };
    const onPause = () => { if (!suppressEmitRef.current) onPlaybackChange("pause", audio.currentTime, song?.songId); };
    const onEnded = () => { if (isHost && onNext) onNext(); };
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onDurationChange = () => setDuration(audio.duration || 0);

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);
    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
    };
  }, [onPlaybackChange, onNext, isHost, song?.songId]);

  // ── Socket sync ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;
    const handleSync = ({ timestamp, isPlaying, songId }) => {
      if (songId && songId !== song?.songId) return;
      if (suppressEmitRef.current) return;
      const audio = audioRef.current;
      if (!audio) return;
      suppressEmitRef.current = true;
      if (Math.abs(audio.currentTime - timestamp) > 1.2) audio.currentTime = timestamp;
      if (isPlaying && audio.paused) audio.play().catch(() => { });
      else if (!isPlaying && !audio.paused) audio.pause();
      setTimeout(() => { suppressEmitRef.current = false; }, 800);
    };
    socket.on("sync_time", handleSync);
    return () => socket.off("sync_time", handleSync);
  }, [socket, song?.songId]);

  // ── Heartbeat ─────────────────────────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      const audio = audioRef.current;
      if (!audio || !roomId || suppressEmitRef.current || !song?.songId) return;
      onSyncEmit(audio.currentTime || 0, !audio.paused, song.songId);
    }, 5000);
    return () => clearInterval(interval);
  }, [roomId, onSyncEmit, song?.songId]);

  // ── UI Helpers ────────────────────────────────────────────────────────
  const formatTime = (s) => {
    if (!s || isNaN(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const handleSeek = (e) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const newTime = ratio * duration;
    suppressEmitRef.current = true;
    audio.currentTime = newTime;
    setCurrentTime(newTime);
    onPlaybackChange("play", newTime, song?.songId);
    setTimeout(() => { suppressEmitRef.current = false; }, 500);
  };

  const handleVolumeChange = (e) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    if (audioRef.current) audioRef.current.volume = v;
    setIsMuted(v === 0);
  };

  const toggleMute = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const next = !isMuted;
    setIsMuted(next);
    audio.volume = next ? 0 : volume;
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const isPlaying = song?.isPlaying;

  return (
    <div className="player-card">
      {/* Hidden audio element — does ALL the work */}
      <audio ref={audioRef} preload="auto" />

      {/* Album Art + Song Info */}
      <div className="player-hero">
        <div className="album-art-wrap">
          {song?.thumbnail
            ? <img className="album-art" src={song.thumbnail} alt={song.title} />
            : <div className="album-art album-art--empty"><span>♪</span></div>
          }
          {resolving && <div className="album-art-overlay"><div className="spinner" /></div>}
        </div>
        <div className="player-meta">
          <div className="player-title">{song?.title || "Nothing playing"}</div>
          <div className="player-artist">{song?.artist || "Add a song to begin"}</div>
          {song?.source === "youtube" && !resolving && !error && song?.songId && (
            <span className="source-badge">Full Track</span>
          )}
          {song?.source === "preview" && (
            <span className="source-badge source-badge--preview">30s Preview</span>
          )}
        </div>
      </div>

      {/* Error */}
      {error && <div className="player-error">⚠ {error}</div>}

      {/* Progress Bar */}
      <div className="progress-wrap" onClick={handleSeek}>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
          <div className="progress-thumb" style={{ left: `${progress}%` }} />
        </div>
        <div className="progress-times">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Volume */}
      <div className="volume-row">
        <button className="vol-btn" onClick={toggleMute}>
          {isMuted || volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}
        </button>
        <input
          className="vol-slider"
          type="range" min="0" max="1" step="0.02"
          value={isMuted ? 0 : volume}
          onChange={handleVolumeChange}
        />
      </div>
    </div>
  );
});

Player.displayName = "Player";
export default Player;