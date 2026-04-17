import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { resolveSong } from "../services/api";

const Player = forwardRef(({ song, roomId, socket, onSyncEmit, onPlaybackChange }, ref) => {
  const audioRef = useRef(null);
  const suppressEmitRef = useRef(false);
  const [resolving, setResolving] = useState(false);

  useImperativeHandle(ref, () => ({
    play: () => {
      if (audioRef.current) {
        audioRef.current.play().catch((e) => console.warn("Manual play failed:", e));
      }
    },
    pause: () => {
      audioRef.current?.pause();
    },
    get audio() {
      return audioRef.current;
    }
  }));

  // Handle song changes and initial state
  useEffect(() => {
    if (!audioRef.current || !song?.songId) return;
    const audio = audioRef.current;

    const applySource = async () => {
      let finalUrl = song.previewUrl;
      
      // If song is from YouTube and needs resolution
      if (song.source === "youtube" && !song.previewUrl) {
        setResolving(true);
        try {
          finalUrl = await resolveSong(song.songId);
        } catch (error) {
          console.error("Resolution failed", error);
          return;
        } finally {
          setResolving(false);
        }
      }

      if (!finalUrl || !audio) return;

      if (audio.src !== finalUrl) {
        console.log("DEBUG: Setting new source", finalUrl);
        suppressEmitRef.current = true;
        audio.src = finalUrl;
        audio.currentTime = Number(song.timestamp || 0);
        
        if (song.isPlaying) {
          audio.play().catch((e) => console.warn("Auto-play blocked:", e));
        } else {
          audio.pause();
        }
        
        setTimeout(() => {
          suppressEmitRef.current = false;
        }, 1000); // Increased suppression to allow for buffer/load
      } else {
        // Source is same, check if we need to sync play/pause status
        const diff = Math.abs(audio.currentTime - Number(song.timestamp || 0));
        
        if (diff > 2.0) { // Increased threshold for drift
          console.log(`DEBUG: Drifting by ${diff}s, syncing...`);
          suppressEmitRef.current = true;
          audio.currentTime = Number(song.timestamp || 0);
          setTimeout(() => suppressEmitRef.current = false, 500);
        }
        
        if (song.isPlaying && audio.paused) {
          audio.play().catch(() => {});
        } else if (!song.isPlaying && !audio.paused) {
          audio.pause();
        }
      }
    };

    applySource();
  }, [song?.songId, song?.previewUrl, song?.isPlaying, song?.timestamp, song?.source]);

  // Handle local user actions
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handlePlay = () => {
      if (suppressEmitRef.current) return;
      onPlaybackChange("play", audio.currentTime);
    };

    const handlePause = () => {
      if (suppressEmitRef.current) return;
      onPlaybackChange("pause", audio.currentTime);
    };

    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);

    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
    };
  }, [onPlaybackChange]);

  // Periodic position report (heartbeat)
  useEffect(() => {
    const interval = setInterval(() => {
      const audio = audioRef.current;
      if (!audio || !roomId || suppressEmitRef.current) return;
      
      const timestamp = audio.currentTime || 0;
      const isPlaying = !audio.paused;
      
      onSyncEmit(timestamp, isPlaying);
    }, 5000); // Send heartbeat every 5 seconds

    return () => clearInterval(interval);
  }, [roomId, onSyncEmit]);

  // Listen for sync events from other clients
  useEffect(() => {
    if (!socket) return;

    const handleSync = ({ timestamp, isPlaying }) => {
      const audio = audioRef.current;
      if (!audio || suppressEmitRef.current) return;

      const current = audio.currentTime || 0;
      const diff = Math.abs(current - timestamp);

      // Only force sync if the drift is significant (> 1s)
      if (diff > 1.2) {
        console.log(`Syncing time: drift of ${diff.toFixed(2)}s detected.`);
        suppressEmitRef.current = true;
        audio.currentTime = timestamp;
        
        if (isPlaying && audio.paused) {
          audio.play().catch(() => {});
        } else if (!isPlaying && !audio.paused) {
          audio.pause();
        }
        
        setTimeout(() => {
          suppressEmitRef.current = false;
        }, 300);
      }
    };

    socket.on("sync_time", handleSync);

    return () => {
      socket.off("sync_time", handleSync);
    };
  }, [socket]);

  return (
    <div className="card player-card">
      <h3>Now Playing</h3>
      {resolving && (
        <div className="resolving-overlay">
          <p>Extracting audio from YouTube...</p>
        </div>
      )}
      {song?.songId ? (
        <div>
          <div className="now-playing">
            <img src={song.thumbnail} alt={song.title} />
            <div>
              <div className="song-title">{song.title}</div>
              <small className="song-artist">{song.artist}</small>
            </div>
            <small className="song-duration">{song.duration}</small>
          </div>
          <audio ref={audioRef} controls className="audio-player" />
        </div>
      ) : (
        <p className="muted">Add a song to start listening together.</p>
      )}
    </div>
  );
});

Player.displayName = "Player";

export default Player;

