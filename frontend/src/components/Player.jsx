import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { searchMusic } from "../services/api";

const Player = forwardRef(({ song, roomId, socket, onSyncEmit, onPlaybackChange, onSongReplace, onNext, isHost }, ref) => {
  const audioRef = useRef(null);
  const ytPlayerRef = useRef(null);
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

  // 2. Manage YouTube Player Lifecycle
  useEffect(() => {
    if (!isYTReady || song?.source !== "youtube" || !song?.songId) {
      if (ytPlayerRef.current) {
        console.log("DEBUG: Destroying YT Player");
        ytPlayerRef.current.destroy();
        ytPlayerRef.current = null;
      }
      return;
    }

    const videoId = song.songId.replace("yt-", "");
    
    // Programmatic change starting - LOCK emissions
    suppressEmitRef.current = true;
    
    if (ytPlayerRef.current && typeof ytPlayerRef.current.loadVideoById === "function") {
      console.log("DEBUG: Updating existing YT Player", videoId);
      ytPlayerRef.current.loadVideoById({
        videoId: videoId,
        startSeconds: Number(song.timestamp || 0)
      });
      if (song.isPlaying) ytPlayerRef.current.playVideo();
      else ytPlayerRef.current.pauseVideo();
    } else {
      console.log("DEBUG: Initializing new YT Player", videoId);
      ytPlayerRef.current = new window.YT.Player("yt-player", {
        height: "240",
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
            if (suppressEmitRef.current) {
              console.log("DEBUG: YT Event Suppressed (Programmatic Change)");
              return;
            }
            
            if (event.data === window.YT.PlayerState.PLAYING) {
              onPlaybackChange("play", event.target.getCurrentTime());
            } else if (event.data === window.YT.PlayerState.PAUSED) {
              onPlaybackChange("pause", event.target.getCurrentTime());
            } else if (event.data === window.YT.PlayerState.ENDED) {
              console.log("DEBUG: YT Ended reached");
              if (isHost && onNext) onNext();
            }
          }
        }
      });
    }

    // Release look after transition settles
    setTimeout(() => {
      suppressEmitRef.current = false;
    }, 2000);

  }, [isYTReady, song?.songId, song?.source]);

  // Handle Play/Pause changes
  useEffect(() => {
    if (!song?.songId) return;
    
    suppressEmitRef.current = true;
    
    if (song.source === "youtube") {
      if (ytPlayerRef.current && typeof ytPlayerRef.current.playVideo === "function") {
        if (song.isPlaying) ytPlayerRef.current.playVideo();
        else ytPlayerRef.current.pauseVideo();
      }
    } else if (audioRef.current) {
      if (song.isPlaying) audioRef.current.play().catch(() => {});
      else audioRef.current.pause();
    }

    setTimeout(() => {
      suppressEmitRef.current = false;
    }, 1000);
  }, [song?.isPlaying]);

  // Handle Sync Time changes
  useEffect(() => {
    if (!song?.songId) return;
    
    suppressEmitRef.current = true;
    const targetTime = Number(song.timestamp || 0);

    if (song.source === "youtube") {
      const player = ytPlayerRef.current;
      if (player && typeof player.getCurrentTime === "function") {
        const diff = Math.abs(player.getCurrentTime() - targetTime);
        if (diff > 2.0) player.seekTo(targetTime);
      }
    } else if (audioRef.current) {
      const diff = Math.abs(audioRef.current.currentTime - targetTime);
      if (diff > 2.0) audioRef.current.currentTime = targetTime;
    }

    setTimeout(() => {
      suppressEmitRef.current = false;
    }, 1000);
  }, [song?.timestamp]);

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

  // Socket Sync Event Handler
  useEffect(() => {
    if (!socket) return;
    
    const handleSync = ({ timestamp, isPlaying, songId }) => {
      if (songId && songId !== song?.songId) return;
      if (suppressEmitRef.current) return;

      suppressEmitRef.current = true;
      if (song?.source === "youtube" && ytPlayerRef.current && typeof ytPlayerRef.current.getCurrentTime === "function") {
        const current = ytPlayerRef.current.getCurrentTime();
        if (Math.abs(current - timestamp) > 1.5) ytPlayerRef.current.seekTo(timestamp);
        if (isPlaying) ytPlayerRef.current.playVideo();
        else ytPlayerRef.current.pauseVideo();
      } else if (audioRef.current) {
        const current = audioRef.current.currentTime || 0;
        if (Math.abs(current - timestamp) > 1.2) audioRef.current.currentTime = timestamp;
        if (isPlaying && audioRef.current.paused) audioRef.current.play().catch(() => {});
        else if (!isPlaying && !audioRef.current.paused) audioRef.current.pause();
      }
      setTimeout(() => { suppressEmitRef.current = false; }, 800);
    };

    socket.on("sync_time", handleSync);
    return () => socket.off("sync_time", handleSync);
  }, [socket, song?.songId, song?.source]);

  // Periodic heartbeat
  useEffect(() => {
    const interval = setInterval(() => {
      if (!roomId || suppressEmitRef.current) return;

      let timestamp = 0;
      let isPlaying = false;

      if (song?.source === "youtube") {
        const player = ytPlayerRef.current;
        if (!player || typeof player.getCurrentTime !== "function" || typeof player.getVideoData !== "function") return;
        
        const videoData = player.getVideoData();
        if (!videoData || videoData.video_id !== song.songId.replace("yt-", "")) return;

        timestamp = player.getCurrentTime();
        isPlaying = player.getPlayerState() === window.YT.PlayerState.PLAYING;
      } else if (audioRef.current) {
        timestamp = audioRef.current.currentTime || 0;
        isPlaying = !audioRef.current.paused;
      }

      onSyncEmit(timestamp, isPlaying, song?.songId);
    }, 5000);

    return () => clearInterval(interval);
  }, [roomId, onSyncEmit, song?.songId, song?.source]);

  return (
    <div className="card player-card">
      <div className="now-playing">
        <img src={song?.thumbnail || ""} alt={song?.title} />
        <div className="song-info">
          <div className="song-title">{song?.title || "No song playing"}</div>
          <div className="song-artist">{song?.artist || "Add a song to start"}</div>
        </div>
      </div>
      
      <div className="player-viewport">
        <div id="yt-player" className={song?.source === "youtube" ? "" : "hidden"} />
        <audio 
          ref={audioRef} 
          controls 
          className={`audio-player ${song?.source === "youtube" ? "hidden" : ""}`}
          onEnded={() => { if (isHost && onNext) onNext(); }}
        />
      </div>
    </div>
  );
});

Player.displayName = "Player";
export default Player;
