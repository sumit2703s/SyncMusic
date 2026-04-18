import { forwardRef, useEffect, useImperativeHandle, useRef, useState, useCallback } from "react";

const Player = forwardRef(({ song, roomId, socket, onSyncEmit, onPlaybackChange, onSongReplace, onNext, isHost }, ref) => {
  const audioRef = useRef(null);
  const ytPlayerRef = useRef(null);
  const suppressEmitRef = useRef(false);
  const loadedSongIdRef = useRef(null);
  const [isYTReady, setIsYTReady] = useState(false);
  const [error, setError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);

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

  // 2. Manage YouTube Player Lifecycle
  useEffect(() => {
    if (!isYTReady || song?.source !== "youtube" || !song?.songId) {
      if (ytPlayerRef.current) {
        ytPlayerRef.current.destroy();
        ytPlayerRef.current = null;
      }
      return;
    }

    const videoId = song.songId.replace("yt-", "");
    suppressEmitRef.current = true;
    
    if (ytPlayerRef.current && typeof ytPlayerRef.current.loadVideoById === "function") {
      ytPlayerRef.current.loadVideoById({
        videoId: videoId,
        startSeconds: Number(song.timestamp || 0)
      });
      if (song.isPlaying) ytPlayerRef.current.playVideo();
      else ytPlayerRef.current.pauseVideo();
    } else {
      ytPlayerRef.current = new window.YT.Player("yt-player", {
        height: "100%",
        width: "100%",
        videoId: videoId,
        playerVars: {
          autoplay: song.isPlaying ? 1 : 0,
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

    setTimeout(() => { suppressEmitRef.current = false; }, 2000);
  }, [isYTReady, song?.songId, song?.source]);

  // 3. Audio Tag Lifecycle (for Previews)
  useEffect(() => {
    if (!song?.songId || !audioRef.current || song?.source === "youtube") {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
      }
      return;
    }

    const loadPreview = () => {
      const audio = audioRef.current;
      if (loadedSongIdRef.current === song.songId) {
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

      const finalUrl = song.previewUrl;
      if (!finalUrl) return;

      loadedSongIdRef.current = song.songId;
      setError("");
      suppressEmitRef.current = true;

      audio.src = finalUrl;
      audio.currentTime = Number(song.timestamp || 0);
      audio.volume = isMuted ? 0 : volume;
      audio.load();

      if (song.isPlaying) {
        audio.play().catch(() => { });
      }

      setTimeout(() => { suppressEmitRef.current = false; }, 1500);
    };

    loadPreview();
  }, [song?.songId, song?.previewUrl, song?.source]);

  // 4. Manual Sync for Audio element (YT handles its own mostly)
  useEffect(() => {
    if (!audioRef.current || !song?.songId || song?.source === "youtube" || loadedSongIdRef.current !== song.songId) return;
    suppressEmitRef.current = true;
    if (song.isPlaying) audioRef.current.play().catch(() => { });
    else audioRef.current.pause();
    setTimeout(() => { suppressEmitRef.current = false; }, 500);
  }, [song?.isPlaying]);

  useEffect(() => {
    if (!audioRef.current || !song?.songId || song?.source === "youtube" || loadedSongIdRef.current !== song.songId) return;
    const diff = Math.abs(audioRef.current.currentTime - Number(song.timestamp || 0));
    if (diff > 2.0) {
      suppressEmitRef.current = true;
      audioRef.current.currentTime = Number(song.timestamp || 0);
      setTimeout(() => { suppressEmitRef.current = false; }, 500);
    }
  }, [song?.timestamp]);

  // 5. Shared Events
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlay = () => { if (!suppressEmitRef.current && song?.source !== "youtube") onPlaybackChange("play", audio.currentTime, song?.songId); };
    const onPause = () => { if (!suppressEmitRef.current && song?.source !== "youtube") onPlaybackChange("pause", audio.currentTime, song?.songId); };
    const onEnded = () => { if (isHost && onNext && song?.source !== "youtube") onNext(); };
    const onTimeUpdate = () => { if (song?.source !== "youtube") setCurrentTime(audio.currentTime); };
    const onDurationChange = () => { if (song?.source !== "youtube") setDuration(audio.duration || 0); };

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
  }, [onPlaybackChange, onNext, isHost, song?.songId, song?.source]);

  // 6. Socket sync & Heartbeat
  useEffect(() => {
    if (!socket) return;
    const handleSync = ({ timestamp, isPlaying, songId }) => {
      if (songId && songId !== song?.songId) return;
      if (suppressEmitRef.current) return;

      suppressEmitRef.current = true;
      if (song?.source === "youtube" && ytPlayerRef.current && typeof ytPlayerRef.current.getCurrentTime === "function") {
        if (Math.abs(ytPlayerRef.current.getCurrentTime() - timestamp) > 2.0) ytPlayerRef.current.seekTo(timestamp);
        if (isPlaying) ytPlayerRef.current.playVideo();
        else ytPlayerRef.current.pauseVideo();
      } else if (audioRef.current && song?.source !== "youtube") {
        const audio = audioRef.current;
        if (Math.abs(audio.currentTime - timestamp) > 1.2) audio.currentTime = timestamp;
        if (isPlaying && audio.paused) audio.play().catch(() => { });
        else if (!isPlaying && !audio.paused) audio.pause();
      }
      setTimeout(() => { suppressEmitRef.current = false; }, 800);
    };
    socket.on("sync_time", handleSync);
    return () => socket.off("sync_time", handleSync);
  }, [socket, song?.songId, song?.source]);

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

  const formatTime = (s) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;

  return (
    <div className="player-card">
      <audio ref={audioRef} preload="auto" className="hidden" />

      <div className="player-hero">
        <div className="album-art-wrap">
          <div id="yt-player" className={song?.source === "youtube" ? "album-art" : "hidden"} />
          {song?.source !== "youtube" && (
            song?.thumbnail 
              ? <img className="album-art" src={song.thumbnail} alt={song.title} />
              : <div className="album-art album-art--empty"><span>♪</span></div>
          )}
        </div>
        <div className="player-meta">
          <div className="player-title">{song?.title || "Nothing playing"}</div>
          <div className="player-artist">{song?.artist || "Add a song to begin"}</div>
          <span className={`source-badge ${song?.source === "preview" ? "source-badge--preview" : ""}`}>
            {song?.source === "youtube" ? "YouTube Full" : "30s Preview"}
          </span>
        </div>
      </div>

      {song?.source !== "youtube" && (
        <div className="progress-wrap" onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const p = (e.clientX - rect.left) / rect.width;
          audioRef.current.currentTime = p * duration;
        }}>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }} />
          </div>
          <div className="progress-times">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>
      )}

      <div className="volume-row">
        <span>{isMuted ? "🔇" : "🔊"}</span>
        <input
          className="vol-slider"
          type="range" min="0" max="1" step="0.01"
          value={volume}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            setVolume(v);
            if (audioRef.current) audioRef.current.volume = v;
            if (ytPlayerRef.current) ytPlayerRef.current.setVolume(v * 100);
          }}
        />
      </div>
    </div>
  );
});

Player.displayName = "Player";
export default Player;