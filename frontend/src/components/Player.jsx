import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

const Player = forwardRef(({ song, roomId, socket, onSyncEmit, onPlaybackChange, onSongReplace, onNext, isHost }, ref) => {
  const audioRef = useRef(null);
  const ytPlayerRef = useRef(null);
  const suppressEmitRef = useRef(false);
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
  }));

  // 2. Lifecycle & Sync
  useEffect(() => {
    if (song?.source === "youtube") {
      // YouTube Logic
      if (!isYTReady || !song?.songId) return;

      const videoId = song.songId.replace("yt-", "");

      if (ytPlayerRef.current && typeof ytPlayerRef.current.loadVideoById === "function") {
        suppressEmitRef.current = true;
        ytPlayerRef.current.loadVideoById({
          videoId: videoId,
          startSeconds: Number(song.timestamp || 0)
        });
        if (song.isPlaying) ytPlayerRef.current.playVideo();
        else ytPlayerRef.current.pauseVideo();
        setTimeout(() => { suppressEmitRef.current = false; }, 1000);
      } else {
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
              event.target.seekTo(Number(song.timestamp || 0));
              if (song.isPlaying) event.target.playVideo();
              else event.target.pauseVideo();
            },
            onStateChange: (event) => {
              if (suppressEmitRef.current) return;
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
      // Audio Tag Logic (Preview)
      if (ytPlayerRef.current) {
        ytPlayerRef.current.destroy();
        ytPlayerRef.current = null;
      }
      
      const audio = audioRef.current;
      if (!audio || !song?.previewUrl) return;

      if (audio.src !== song.previewUrl) {
        suppressEmitRef.current = true;
        audio.src = song.previewUrl;
        audio.currentTime = Number(song.timestamp || 0);
        audio.load();
        if (song.isPlaying) audio.play().catch(() => { });
        setTimeout(() => { suppressEmitRef.current = false; }, 1000);
      } else {
        // Just sync state
        const diff = Math.abs(audio.currentTime - Number(song.timestamp || 0));
        if (diff > 2.0) {
          suppressEmitRef.current = true;
          audio.currentTime = Number(song.timestamp || 0);
          setTimeout(() => { suppressEmitRef.current = false; }, 500);
        }
        if (song.isPlaying && audio.paused) audio.play().catch(() => { });
        else if (!song.isPlaying && !audio.paused) audio.pause();
      }
    }
  }, [song?.songId, isYTReady, song?.source, onPlaybackChange, isHost, onNext, song?.previewUrl]);

  // 3. Socket sync_time handler
  useEffect(() => {
    if (!socket) return;
    const handleSync = ({ timestamp, isPlaying, songId }) => {
      if (songId && songId !== song?.songId) return;
      if (suppressEmitRef.current) return;

      suppressEmitRef.current = true;
      if (song?.source === "youtube" && ytPlayerRef.current && typeof ytPlayerRef.current.getCurrentTime === "function") {
        if (Math.abs(ytPlayerRef.current.getCurrentTime() - timestamp) > 1.2) {
          ytPlayerRef.current.seekTo(timestamp, true);
        }
        if (isPlaying) ytPlayerRef.current.playVideo();
        else ytPlayerRef.current.pauseVideo();
      } else if (audioRef.current && song?.source !== "youtube") {
        const audio = audioRef.current;
        if (Math.abs(audio.currentTime - timestamp) > 1.2) {
          audio.currentTime = timestamp;
        }
        if (isPlaying && audio.paused) audio.play().catch(() => { });
        else if (!isPlaying && !audio.paused) audio.pause();
      }
      setTimeout(() => { suppressEmitRef.current = false; }, 800);
    };
    socket.on("sync_time", handleSync);
    return () => socket.off("sync_time", handleSync);
  }, [socket, song?.songId, song?.source]);

  // 4. Heartbeat
  useEffect(() => {
    const interval = setInterval(() => {
      if (!roomId || suppressEmitRef.current || !song?.songId) return;
      let ts = 0, playing = false;
      if (song?.source === "youtube" && ytPlayerRef.current && typeof ytPlayerRef.current.getCurrentTime === "function") {
        ts = ytPlayerRef.current.getCurrentTime();
        playing = ytPlayerRef.current.getPlayerState() === window.YT.PlayerState.PLAYING;
      } else if (audioRef.current && song?.source !== "youtube") {
        ts = audioRef.current.currentTime;
        playing = !audioRef.current.paused;
      }
      if (ts !== undefined) onSyncEmit(ts, playing, song.songId);
    }, 5000);
    return () => clearInterval(interval);
  }, [roomId, onSyncEmit, song?.songId, song?.source]);

  // 5. Shared Events for Audio tag
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || song?.source === "youtube") return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onDurationChange = () => setDuration(audio.duration || 0);
    const onEnded = () => { if (isHost && onNext) onNext(); };
    const onPlay = () => { if (!suppressEmitRef.current) onPlaybackChange("play", audio.currentTime, song?.songId); };
    const onPause = () => { if (!suppressEmitRef.current) onPlaybackChange("pause", audio.currentTime, song?.songId); };

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