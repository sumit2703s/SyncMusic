import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

const Player = forwardRef(({ song, roomId, socket, onSyncEmit, onPlaybackChange, onSongReplace, onNext, isHost, userId, hostId }, ref) => {
  const audioRef = useRef(null);
  const ytPlayerRef = useRef(null);
  const suppressOutgoingRef = useRef(false);
  const loadedSongIdRef = useRef(null);
  const pendingSyncRef = useRef(null); // NEW: Store sync data if player not ready
  const [isYTReady, setIsYTReady] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // 1. YouTube IFrame API Loader
  useEffect(() => {
    if (window.YT && window.YT.Player) {
      setIsYTReady(true);
      return;
    }

    if (!document.getElementById("youtube-iframe-api")) {
      const tag = document.createElement("script");
      tag.id = "youtube-iframe-api";
      tag.src = "https://www.youtube.com/iframe_api";
      const firstScriptTag = document.getElementsByTagName("script")[0];
      firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
    }

    const prevOnReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (prevOnReady) prevOnReady();
      setIsYTReady(true);
    };
  }, []);

  useImperativeHandle(ref, () => ({
    play: () => {
      if (song?.source === "youtube") ytPlayerRef.current?.playVideo();
      else audioRef.current?.play().catch(() => { });
    },
    pause: () => {
      if (song?.source === "youtube") ytPlayerRef.current?.pauseVideo();
      else audioRef.current?.pause();
    },
    syncTo: (timestamp, isPlaying) => {
      suppressOutgoingRef.current = true;
      if (song?.source === "youtube") {
        if (ytPlayerRef.current && typeof ytPlayerRef.current.seekTo === "function") {
          ytPlayerRef.current.seekTo(timestamp, true);
          if (isPlaying) ytPlayerRef.current.playVideo();
          else ytPlayerRef.current.pauseVideo();
          pendingSyncRef.current = null;
        } else {
          // If not ready, queue it for when onReady fires
          pendingSyncRef.current = { timestamp, isPlaying };
        }
      } else if (audioRef.current && song?.source !== "youtube") {
        audioRef.current.currentTime = timestamp;
        if (isPlaying) audioRef.current.play().catch(() => {});
        else audioRef.current.pause();
      }
      setTimeout(() => { suppressOutgoingRef.current = false; }, 1000);
    }
  }));

  // 2. STRICT LIFECYCLE: Destroy and Re-init on Song Change
  useEffect(() => {
    if (!song?.songId) return;

    if (song.source === "youtube") {
      if (!isYTReady) return;
      const videoId = song.songId.replace("yt-", "");

      if (loadedSongIdRef.current !== song.songId) {
        if (ytPlayerRef.current) {
          try { ytPlayerRef.current.destroy(); } catch(e) { console.warn("Player destroy failed", e); }
          ytPlayerRef.current = null;
        }

        const playerDiv = document.getElementById("yt-player");
        if (playerDiv) playerDiv.innerHTML = ""; 

        ytPlayerRef.current = new window.YT.Player("yt-player", {
          height: "100%",
          width: "100%",
          videoId: videoId,
          playerVars: {
            autoplay: song.isPlaying ? 1 : 0,
            controls: 1,
            rel: 0,
            fs: 1,
            origin: window.location.origin,
            enablejsapi: 1,
            playsinline: 1
          },
          events: {
            onReady: (event) => {
              loadedSongIdRef.current = song.songId;
              
              // Apply pending sync if it exists, else use song defaults
              const initialSync = pendingSyncRef.current || { timestamp: song.timestamp, isPlaying: song.isPlaying };
              event.target.seekTo(Number(initialSync.timestamp || 0));
              if (initialSync.isPlaying) event.target.playVideo();
              else event.target.pauseVideo();
              
              pendingSyncRef.current = null; // clear after apply
            },
            onStateChange: (event) => {
              if (suppressOutgoingRef.current) return;
              if (event.data === window.YT.PlayerState.PLAYING) {
                onPlaybackChange("play", event.target.getCurrentTime(), song?.songId);
              } else if (event.data === window.YT.PlayerState.PAUSED) {
                onPlaybackChange("pause", event.target.getCurrentTime(), song?.songId);
              } else if (event.data === window.YT.PlayerState.ENDED) {
                if (isHost && onNext) onNext();
              }
            }
          }
        });
      }
    } else {
      // Audio Tag Logic
      if (ytPlayerRef.current) {
        try { ytPlayerRef.current.destroy(); } catch(e) {}
        ytPlayerRef.current = null;
      }
      
      const audio = audioRef.current;
      if (!audio || !song?.previewUrl) return;

      if (loadedSongIdRef.current !== song.songId || audio.src !== song.previewUrl) {
        loadedSongIdRef.current = song.songId;
        suppressOutgoingRef.current = true;
        audio.src = song.previewUrl;
        audio.currentTime = Number(song.timestamp || 0);
        audio.load();
        if (song.isPlaying) audio.play().catch(() => { });
        setTimeout(() => { suppressOutgoingRef.current = false; }, 1000);
      }
    }
  }, [song?.songId, isYTReady, song?.source, isHost, onNext, song?.previewUrl]);

  // 3. Socket sync_time handler (incoming)
  useEffect(() => {
    if (!socket) return;
    const handleSync = ({ timestamp, isPlaying, songId }) => {
      if (songId && songId !== song?.songId) return;
      
      if (song?.source === "youtube") {
        if (ytPlayerRef.current && typeof ytPlayerRef.current.getCurrentTime === "function") {
          const current = ytPlayerRef.current.getCurrentTime() || 0;
          if (Math.abs(current - timestamp) > 1.2) {
            ytPlayerRef.current.seekTo(timestamp, true);
            if (isPlaying) ytPlayerRef.current.playVideo();
            else ytPlayerRef.current.pauseVideo();
          }
        } else {
          // Store it if we don't have a player yet
          pendingSyncRef.current = { timestamp, isPlaying };
        }
      } else if (audioRef.current && song?.source !== "youtube") {
        const audio = audioRef.current;
        const current = audio.currentTime || 0;
        if (Math.abs(current - timestamp) > 1.2) {
          suppressOutgoingRef.current = true;
          audio.currentTime = timestamp;
          if (isPlaying) audio.play().catch(() => {});
          else audio.pause();
          setTimeout(() => { suppressOutgoingRef.current = false; }, 300);
        }
      }
    };
    socket.on("sync_time", handleSync);
    return () => socket.off("sync_time", handleSync);
  }, [socket, song?.songId, song?.source]);

  // 4. Heartbeat — only HOST emits sync_time
  useEffect(() => {
    const interval = setInterval(() => {
      const isHostLocal = hostId === userId; 
      if (!isHostLocal || !roomId || suppressOutgoingRef.current || !song?.songId) return;
      
      let timestamp = 0;
      if (song?.source === "youtube" && ytPlayerRef.current && typeof ytPlayerRef.current.getCurrentTime === "function") {
        timestamp = ytPlayerRef.current.getCurrentTime() || 0;
      } else if (audioRef.current && song?.source !== "youtube") {
        timestamp = audioRef.current.currentTime || 0;
      }
      
      const isPlaying = song?.isPlaying || false;
      if (timestamp !== undefined) onSyncEmit(timestamp, isPlaying, song.songId);
    }, 5000);
    return () => clearInterval(interval);
  }, [roomId, onSyncEmit, song?.songId, song?.source, hostId, userId]);

  // 5. Shared Events for Audio tag
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || song?.source === "youtube") return;

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
  }, [song?.source, onPlaybackChange, isHost, onNext, song?.songId]);

  return (
    <div className="player-card">
      <div className="player-hero">
        <div className="album-art-wrap" style={{ width: "100%", height: song?.source === "youtube" ? "auto" : "200px", aspectRatio: song?.source === "youtube" ? "16/9" : "1/1" }}>
          {song?.source === "youtube" ? (
            <div id="yt-player" style={{ width: "100%", height: "100%", borderRadius: "10px", overflow: "hidden" }} />
          ) : (
            song?.thumbnail 
              ? <img className="album-art" src={song.thumbnail} alt={song.title} style={{ width: "100%", height: "100%", borderRadius: "12px", objectFit: "cover" }} />
              : <div className="album-art album-art--empty"><span>♪</span></div>
          )}
        </div>
        
        <div className="player-meta" style={{ marginTop: "16px", textAlign: "center" }}>
          <div className="player-title" style={{ fontSize: "1.2rem", fontWeight: "bold" }}>{song?.title || "Nothing playing"}</div>
          <div className="player-artist" style={{ color: "#777" }}>{song?.artist || "Add a song to begin"}</div>
          <div className="source-badge" style={{ marginTop: "8px", display: "inline-block", padding: "2px 8px", background: "#333", borderRadius: "5px", fontSize: "0.7rem" }}>
            {song?.source === "youtube" ? "YouTube Full" : "30s Preview"}
          </div>
        </div>
      </div>

      {song?.source !== "youtube" && (
        <audio ref={audioRef} controls className="audio-player" style={{ width: "100%", marginTop: "16px" }} />
      )}
    </div>
  );
});

Player.displayName = "Player";
export default Player;