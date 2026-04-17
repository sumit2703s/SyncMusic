import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { searchMusic } from "../services/api";

const Player = forwardRef(({ song, roomId, socket, onSyncEmit, onPlaybackChange }, ref) => {
  const audioRef = useRef(null);
  const ytPlayerRef = useRef(null);
  const ytPlayerContainerRef = useRef(null);
  const suppressEmitRef = useRef(false);
  const [error, setError] = useState("");
  const [isYTReady, setIsYTReady] = useState(false);

  // 1. Load YouTube IFrame API Script
  useEffect(() => {
    if (window.YT) {
      setIsYTReady(true);
      return;
    }

    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    const firstScriptTag = document.getElementsByTagName("script")[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

    window.onYouTubeIframeAPIReady = () => {
      console.log("DEBUG: YouTube IFrame API Ready");
      setIsYTReady(true);
    };
  }, []);

  // 2. Initialize / Update YouTube Player
  useEffect(() => {
    if (!isYTReady || song?.source !== "youtube" || !song?.songId) {
      if (ytPlayerRef.current) {
        console.log("DEBUG: Destroying YT Player as source changed");
        ytPlayerRef.current.destroy();
        ytPlayerRef.current = null;
      }
      return;
    }

    const videoId = song.songId.replace("yt-", "");
    
    // If player exists, just load new video
    if (ytPlayerRef.current && typeof ytPlayerRef.current.loadVideoById === "function") {
      console.log("DEBUG: Loading new video into existing YT Player", videoId);
      ytPlayerRef.current.loadVideoById({
        videoId: videoId,
        startSeconds: Number(song.timestamp || 0)
      });
      if (song.isPlaying) ytPlayerRef.current.playVideo();
      else ytPlayerRef.current.pauseVideo();
      return;
    }

    // Create new player
    console.log("DEBUG: Creating new YT Player for", videoId);
    ytPlayerRef.current = new window.YT.Player("yt-player", {
      height: "200",
      width: "100%",
      videoId: videoId,
      playerVars: {
        autoplay: 1,
        controls: 1,
        modestbranding: 1,
        origin: window.location.origin,
        playsinline: 1,
        enablejsapi: 1
      },
      events: {
        onReady: (event) => {
          event.target.seekTo(Number(song.timestamp || 0));
          if (song.isPlaying) event.target.playVideo();
          else event.target.pauseVideo();
        },
        onStateChange: (event) => {
          if (suppressEmitRef.current) return;
          
          // PLAYING = 1, PAUSED = 2
          if (event.data === window.YT.PlayerState.PLAYING) {
            onPlaybackChange("play", event.target.getCurrentTime());
          } else if (event.data === window.YT.PlayerState.PAUSED) {
            onPlaybackChange("pause", event.target.getCurrentTime());
          }
        }
      }
    });
  }, [isYTReady, song?.songId, song?.source]);

  // 3. Handle Standard Audio Player Source Change
  useEffect(() => {
    if (song?.source === "youtube" || !song?.songId || !audioRef.current) return;
    const audio = audioRef.current;
    const finalUrl = song.previewUrl;

    if (audio.src !== finalUrl) {
      console.log("DEBUG: Setting new audio source", finalUrl);
      suppressEmitRef.current = true;
      audio.src = finalUrl;
      audio.currentTime = Number(song.timestamp || 0);
      if (song.isPlaying) audio.play().catch(() => {});
      else audio.pause();
      setTimeout(() => { suppressEmitRef.current = false; }, 1000);
    } else {
      const diff = Math.abs(audio.currentTime - Number(song.timestamp || 0));
      if (diff > 2.0) {
        suppressEmitRef.current = true;
        audio.currentTime = Number(song.timestamp || 0);
        setTimeout(() => suppressEmitRef.current = false, 500);
      }
      if (song.isPlaying && audio.paused) audio.play().catch(() => {});
      else if (!song.isPlaying && !audio.paused) audio.pause();
    }
  }, [song?.songId, song?.previewUrl, song?.isPlaying, song?.timestamp, song?.source]);

  // Handle manual ref calls from parent
  useImperativeHandle(ref, () => ({
    play: () => {
      if (song?.source === "youtube") ytPlayerRef.current?.playVideo();
      else audioRef.current?.play().catch(() => {});
    },
    pause: () => {
      if (song?.source === "youtube") ytPlayerRef.current?.pauseVideo();
      else audioRef.current?.pause();
    }
  }));

  // Synchronize with socket events
  useEffect(() => {
    if (!socket) return;
    
    const handleSync = ({ timestamp, isPlaying, songId }) => {
      // If the sync event is for a different song, ignore it
      if (songId && songId !== song?.songId) return;
      if (suppressEmitRef.current) return;

      if (song?.source === "youtube") {
        const player = ytPlayerRef.current;
        if (!player || typeof player.getCurrentTime !== "function") return;
        const current = player.getCurrentTime();
        if (Math.abs(current - timestamp) > 1.5) {
          suppressEmitRef.current = true;
          player.seekTo(timestamp);
          if (isPlaying) player.playVideo();
          else player.pauseVideo();
          setTimeout(() => { suppressEmitRef.current = false; }, 500);
        }
      } else {
        const audio = audioRef.current;
        if (!audio) return;
        const current = audio.currentTime || 0;
        if (Math.abs(current - timestamp) > 1.2) {
          suppressEmitRef.current = true;
          audio.currentTime = timestamp;
          if (isPlaying && audio.paused) audio.play().catch(() => {});
          else if (!isPlaying && !audio.paused) audio.pause();
          setTimeout(() => { suppressEmitRef.current = false; }, 300);
        }
      }
    };

    socket.on("sync_time", handleSync);
    return () => socket.off("sync_time", handleSync);
  }, [socket, song?.source]);

  // Periodic heartbeat sync
  useEffect(() => {
    const interval = setInterval(() => {
      if (!roomId || suppressEmitRef.current) return;

      let timestamp = 0;
      let isPlaying = false;

      if (song?.source === "youtube") {
        const player = ytPlayerRef.current;
        if (!player || typeof player.getCurrentTime !== "function") return;
        timestamp = player.getCurrentTime();
        isPlaying = player.getPlayerState() === window.YT.PlayerState.PLAYING;
      } else {
        const audio = audioRef.current;
        if (!audio) return;
        timestamp = audio.currentTime || 0;
        isPlaying = !audio.paused;
      }

      onSyncEmit(timestamp, isPlaying, song?.songId);
    }, 5000);

    return () => clearInterval(interval);
  }, [roomId, onSyncEmit, song?.source]);

  return (
    <div className="card player-card">
      <h3>Now Playing</h3>
      {error && (
        <div className="error-overlay" style={{ background: "rgba(255,0,0,0.1)", padding: "10px", borderRadius: "8px", marginBottom: "10px", border: "1px solid rgba(255,0,0,0.3)" }}>
          <p style={{ color: "#ff4444", fontSize: "0.9rem", margin: 0 }}>⚠️ {error}</p>
        </div>
      )}
      {song?.songId ? (
        <div>
          <div className="now-playing">
            <img src={song.thumbnail} alt={song.title} />
            <div>
              <div className="song-title">{song.title}</div>
              <small className="song-artist">{song.artist}</small>
              {song.source === "preview" && (
                <small style={{ color: "#888", display: "block", fontSize: "0.75rem" }}>
                  🎧 30s Preview
                </small>
              )}
            </div>
            <small className="song-duration">{song.duration}</small>
          </div>
          
          <div className="player-container" style={{ marginTop: "15px" }}>
            {/* YouTube IFrame Container */}
            <div 
              id="yt-player" 
              style={{ 
                display: song?.source === "youtube" ? "block" : "none",
                width: "100%",
                borderRadius: "10px",
                overflow: "hidden",
                aspectRatio: "16/9",
                background: "#000"
              }} 
            />
            
            {/* Standard Audio Player */}
            <audio 
              ref={audioRef} 
              controls 
              className="audio-player" 
              style={{ display: song?.source === "youtube" ? "none" : "block" }} 
            />
          </div>
        </div>
      ) : (
        <p className="muted">Add a song to start listening together.</p>
      )}
    </div>
  );
});

Player.displayName = "Player";

export default Player;
