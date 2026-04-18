import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { resolveSong, searchMusic } from "../services/api";

const Player = forwardRef(({ song, roomId, socket, onSyncEmit, onPlaybackChange, onSongReplace, onNext, isHost }, ref) => {
  const audioRef = useRef(null);
  const suppressEmitRef = useRef(false);
  const currentSongIdRef = useRef(null); // tracks which song is currently loaded
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");

  useImperativeHandle(ref, () => ({
    play: () => audioRef.current?.play().catch(() => { }),
    pause: () => audioRef.current?.pause(),
    get audio() { return audioRef.current; }
  }));

  // ── Core: Load a new song into <audio> whenever songId changes ───────
  useEffect(() => {
    if (!song?.songId || !audioRef.current) return;

    // Same song already loaded — just sync play/pause & drift
    if (currentSongIdRef.current === song.songId) {
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

    // New song — resolve URL and load
    const loadSong = async () => {
      let finalUrl = song.previewUrl || "";

      if (song.source === "youtube" && !finalUrl) {
        setResolving(true);
        setError("");
        try {
          finalUrl = await resolveSong(song.songId);
          if (!finalUrl) throw new Error("No URL returned");
        } catch (err) {
          console.warn("YouTube resolution failed, trying preview fallback...", err);
          try {
            const query = `${song.title} ${song.artist}`;
            const previews = await searchMusic(query, "preview");
            if (previews?.length > 0) {
              const fallback = { ...previews[0], _fallbackFor: song.songId };
              console.log("DEBUG: Using preview fallback", fallback.title);
              if (onSongReplace) {
                onSongReplace(fallback);
                setResolving(false);
                return;
              }
              finalUrl = previews[0].previewUrl;
            } else {
              throw new Error("No preview found");
            }
          } catch {
            setError("YouTube blocked this track & no preview found. Try 'Short Previews' mode.");
            setResolving(false);
            return;
          }
        } finally {
          setResolving(false);
        }
      }

      if (!finalUrl) return;

      const audio = audioRef.current;
      if (!audio) return;

      console.log("DEBUG: Loading audio for:", song.title);
      currentSongIdRef.current = song.songId;
      setError("");
      suppressEmitRef.current = true;

      audio.src = finalUrl;
      audio.currentTime = Number(song.timestamp || 0);
      audio.load();

      if (song.isPlaying) {
        audio.play().catch((e) => console.warn("Autoplay blocked:", e));
      } else {
        audio.pause();
      }

      setTimeout(() => { suppressEmitRef.current = false; }, 1500);
    };

    loadSong();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.songId, song?.previewUrl, song?.source]);

  // ── Sync play/pause state without reloading the song ─────────────────
  useEffect(() => {
    if (!song?.songId || !audioRef.current) return;
    if (currentSongIdRef.current !== song.songId) return;
    suppressEmitRef.current = true;
    if (song.isPlaying) audioRef.current.play().catch(() => { });
    else audioRef.current.pause();
    setTimeout(() => { suppressEmitRef.current = false; }, 500);
  }, [song?.isPlaying]);

  // ── Seek sync ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!song?.songId || !audioRef.current) return;
    if (currentSongIdRef.current !== song.songId) return;
    const diff = Math.abs(audioRef.current.currentTime - Number(song.timestamp || 0));
    if (diff > 2.0) {
      suppressEmitRef.current = true;
      audioRef.current.currentTime = Number(song.timestamp || 0);
      setTimeout(() => { suppressEmitRef.current = false; }, 500);
    }
  }, [song?.timestamp]);

  // ── Local audio events → broadcast to room ────────────────────────────
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlay = () => {
      if (suppressEmitRef.current) return;
      onPlaybackChange("play", audio.currentTime, song?.songId);
    };
    const onPause = () => {
      if (suppressEmitRef.current) return;
      onPlaybackChange("pause", audio.currentTime, song?.songId);
    };
    const onEnded = () => {
      if (isHost && onNext) onNext();
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
  }, [onPlaybackChange, onNext, isHost, song?.songId]);

  // ── Receive sync events from other room members ───────────────────────
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

  // ── Heartbeat: report position every 5s ──────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      const audio = audioRef.current;
      if (!audio || !roomId || suppressEmitRef.current || !song?.songId) return;
      onSyncEmit(audio.currentTime || 0, !audio.paused, song.songId);
    }, 5000);
    return () => clearInterval(interval);
  }, [roomId, onSyncEmit, song?.songId]);

  return (
    <div className="card player-card">
      {/* Song Info */}
      <div className="now-playing">
        {song?.thumbnail ? (
          <img src={song.thumbnail} alt={song?.title || "Song"} />
        ) : (
          <div style={{
            width: 56, height: 56, borderRadius: 10,
            background: "#222", flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 24
          }}>🎵</div>
        )}
        <div className="song-info" style={{ flex: 1, overflow: "hidden" }}>
          <div className="song-title" style={{
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
          }}>
            {song?.title || "No song playing"}
          </div>
          <div className="song-artist" style={{ color: "#aaa", fontSize: "0.85rem" }}>
            {song?.artist || "Add a song to start"}
          </div>
        </div>
      </div>

      {/* Status messages */}
      {resolving && (
        <p style={{ color: "#aaa", fontSize: "0.85rem", margin: "10px 0 4px" }}>
          ⏳ Loading audio...
        </p>
      )}
      {error && (
        <div style={{
          background: "rgba(255,60,60,0.1)",
          border: "1px solid rgba(255,60,60,0.3)",
          borderRadius: "8px", padding: "8px 12px", margin: "8px 0",
        }}>
          <p style={{ color: "#ff5555", fontSize: "0.85rem", margin: 0 }}>⚠️ {error}</p>
        </div>
      )}

      {/* Clean audio player — NO YouTube iframe anywhere */}
      <audio
        ref={audioRef}
        controls
        className="audio-player"
        style={{
          width: "100%",
          marginTop: "12px",
          display: song?.songId ? "block" : "none",
          borderRadius: "8px",
        }}
      />

      {!song?.songId && !resolving && (
        <p className="muted" style={{ marginTop: "14px" }}>
          Add a song to start listening together.
        </p>
      )}
    </div>
  );
});

Player.displayName = "Player";
export default Player;