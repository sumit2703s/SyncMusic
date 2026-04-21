import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Player from "./components/Player";
import Queue from "./components/Queue";
import Room from "./components/Room";
import Users from "./components/Users";
import { useSocket } from "./hooks/useSocket";
import {
  addSongToQueue, createRoom, joinRoom, kickMember,
  searchMusic,
} from "./services/api";

const randomId = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;

export default function App() {
  const socket = useSocket();
  const [userId] = useState(() => randomId());
  const [username, setUsername] = useState("");
  const [roomId, setRoomId] = useState("");
  const [joined, setJoined] = useState(false);
  const [queue, setQueue] = useState([]);
  const [users, setUsers] = useState([]);
  const [state, setState] = useState({});
  const [roomLoading, setRoomLoading] = useState(false);
  const [roomError, setRoomError] = useState("");
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const pendingRoomJoin = useRef(null);
  const playerRef = useRef(null);

  const hostId = useMemo(() => state?.hostId || "", [state]);
  const isHost = userId === hostId;

  // ── Join / Create Room ───────────────────────────────────────────────
  const enterRoom = async (fn, inputUsername, inputRoomId, mode) => {
    const cleanUsername = inputUsername?.trim() || `Guest-${String(userId).slice(0, 4)}`;
    const cleanRoomId = inputRoomId?.trim() || "";
    if (mode === "join" && !cleanRoomId) { setRoomError("Enter a Room ID to join."); return; }

    setRoomError(""); setRoomLoading(true);
    try {
      setUsername(cleanUsername);
      const data = await fn({ roomId: cleanRoomId, userId, username: cleanUsername });
      const nextRoomId = data.roomId || cleanRoomId;
      if (!nextRoomId) { setRoomError("Could not determine room ID."); return; }
      setRoomId(nextRoomId); setJoined(true);
      if (data.state) setState(data.state);
      if (data.queue) setQueue(data.queue);
      if (data.users) setUsers(data.users);

      const joinPayload = { roomId: nextRoomId, userId, username: cleanUsername };
      const joinCallback = (res) => {
        if (res?.error) { setRoomError(res.error); return; }
        setState(res.state || {}); setQueue(res.queue || []); setUsers(res.users || []);
      };
      if (socket.connected) socket.emit("join_room", joinPayload, joinCallback);
      else pendingRoomJoin.current = { payload: joinPayload, callback: joinCallback };
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setRoomError(typeof detail === "string" ? detail : "Failed to connect. Check backend.");
    } finally { setRoomLoading(false); }
  };

  // ── Socket listeners ──────────────────────────────────────────────────
  useEffect(() => {
    if (socket.connected) { setConnected(true); setConnectionError(""); }

    socket.on("connect", () => {
      setConnected(true); setConnectionError("");
      if (pendingRoomJoin.current) {
        socket.emit("join_room", pendingRoomJoin.current.payload, (res) => {
          pendingRoomJoin.current.callback?.(res);
          pendingRoomJoin.current = null;
        });
      }
    });
    socket.on("connect_error", (err) => { setConnected(false); setConnectionError(err?.message || "Connection error"); });
    socket.on("disconnect", (reason) => { setConnected(false); setConnectionError(`Disconnected: ${reason}`); });

    socket.on("room_state", (payload) => {
      const newState = payload.state || {};
      // Set timestamp to computed sync position for accurate join
      if (payload.syncTime != null) {
        newState.timestamp = payload.syncTime;
      }
      setState(newState);
      setQueue(payload.queue || []);
      setUsers(payload.users || []);
      // Player auto-loads via its useEffect when state/songId changes
    });
    socket.on("queue_updated", ({ queue: q }) => setQueue(q || []));
    socket.on("user_joined", ({ user: u }) => {
      if (!u) return;
      setUsers((prev) => prev.some((x) => x.userId === u.userId) ? prev : [...prev, u]);
    });
    socket.on("user_left", ({ users: u }) => setUsers(u || []));
    socket.on("song_changed", ({ state: nextState, queue: nextQueue, serverNow }) => {
      if (nextState) {
        // Compensate for network delay: if the server says the song started at time X,
        // and we received this message (serverNow -> now = transit time), adjust timestamp
        if (nextState.startedAt && serverNow && nextState.isPlaying) {
          const networkDelay = Math.max(0, (Date.now() / 1000) - serverNow);
          nextState.timestamp = (nextState.timestamp || 0) + networkDelay;
        }
      }
      setState(nextState || {});
      if (nextQueue) setQueue(nextQueue);
      // Player auto-loads via its useEffect when songId changes
    });
    socket.on("song_paused", ({ state: nextState, serverNow }) => {
      if (nextState && serverNow) {
        const networkDelay = Math.max(0, (Date.now() / 1000) - serverNow);
        nextState.timestamp = (nextState.timestamp || 0) + networkDelay;
      }
      setState(nextState || {});
      if (playerRef.current) {
        playerRef.current.syncTo(nextState.timestamp || 0, false);
      }
    });
    socket.on("song_restarted", ({ state: s, serverNow }) => {
      if (s && s.startedAt && serverNow && s.isPlaying) {
        const networkDelay = Math.max(0, (Date.now() / 1000) - serverNow);
        s.timestamp = (s.timestamp || 0) + networkDelay;
      }
      setState(s || {});
    });
    socket.on("host_changed", ({ hostId: h }) => setState((p) => ({ ...p, hostId: h })));
    socket.on("queue_empty", () => setState((p) => ({ ...p, songId: null, isPlaying: false, title: null, artist: null, thumbnail: null })));
    socket.on("kicked", ({ roomId: kr }) => {
      if (kr && kr !== roomId) return;
      alert("You were removed from the room.");
      setJoined(false); setRoomId(""); setQueue([]); setUsers([]); setState({});
    });

    return () => {
      ["room_state", "queue_updated", "user_joined", "user_left", "song_changed",
        "song_paused", "song_restarted", "host_changed", "queue_empty", "kicked"].forEach((e) => socket.off(e));
    };
  }, [socket, roomId]);

  // Fix #13: Keep Render HTTP service awake + ensure socket stays connected
  useEffect(() => {
    const keepAlive = setInterval(() => {
      fetch(import.meta.env.VITE_BACKEND_URL + "/health").catch(() => {});
      if (socket && !socket.connected) socket.connect();
    }, 25000);
    return () => clearInterval(keepAlive);
  }, [socket]);

  // ── Song controls ─────────────────────────────────────────────────────
  const playSelectedSong = useCallback((song) => {
    if (!roomId || !song?.songId) return;
    socket.emit("play_song", { roomId, song, timestamp: 0 });
  }, [roomId, socket]);

  const goToNextSong = useCallback(() => {
    if (!roomId) return;
    socket.emit("next_song", { roomId });
  }, [roomId, socket]);

  const goToPrevSong = useCallback(() => {
    if (!roomId) return;
    socket.emit("prev_song", { roomId });
  }, [roomId, socket]);

  const handleTogglePlay = () => {
    if (!roomId) return;
    if (!state.songId && queue.length > 0) { playSelectedSong(queue[0]); return; }
    if (!state.songId) return;
    const nextPlaying = !state.isPlaying;
    setState((p) => ({ ...p, isPlaying: nextPlaying }));
    if (nextPlaying) playerRef.current?.play();
    else playerRef.current?.pause();
  };

  const onSyncEmit = useCallback((timestamp, isPlaying, songId) => {
    if (!roomId || !songId) return;
    socket.emit("sync_time", { roomId, songId, timestamp, isPlaying });
  }, [roomId, socket]);

  // Fix #2: Use socket instead of REST to avoid dual-fire race conditions
  const onPlaybackChange = useCallback((type, timestamp, songId) => {
    if (!roomId || !songId) return;
    if (type === "play") {
      socket.emit("sync_time", { roomId, songId, timestamp, isPlaying: true });
    } else {
      socket.emit("pause_song", { roomId, timestamp });
    }
  }, [roomId, socket]);

  // Fix #14: Allow removing songs from the queue
  const removeFromQueue = useCallback((index) => {
    if (!roomId || index == null) return;
    socket.emit("remove_from_queue", { roomId, index }, (res) => {
      if (res?.queue) setQueue(res.queue);
    });
  }, [roomId, socket]);

  // ── Search ────────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [addingSongId, setAddingSongId] = useState("");
  const [searchSource, setSearchSource] = useState("full");

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try { setResults(await searchMusic(searchQuery.trim(), searchSource)); }
    finally { setSearching(false); }
  };

  const addSong = (song, onAdded) => {
    if (!roomId) { alert("Join a room first."); return; }
    if (!song?.songId || addingSongId) return;
    setAddingSongId(song.songId);
    addSongToQueue(roomId, song)
      .then((result) => {
        if (Array.isArray(result?.queue)) setQueue(result.queue);
        else setQueue((p) => [...p, song]);
        if (!state.songId && socket.connected) {
          socket.emit("play_song", { roomId, song, timestamp: 0 });
        }
        setResults([]); onAdded();
      })
      .catch((e) => alert(`Failed to add: ${e?.response?.data?.detail || e?.message}`))
      .finally(() => setAddingSongId(""));
  };

  const removeMember = (member) => {
    if (!roomId || !member?.userId) return;
    kickMember(roomId, userId, member.userId)
      .then((r) => { if (Array.isArray(r?.users)) setUsers(r.users); })
      .catch((e) => alert(`Failed: ${e?.response?.data?.detail || e?.message}`));
  };

  if (!joined) {
    return <Room onCreate={(u, r) => enterRoom(createRoom, u, r, "create")} onJoin={(u, r) => enterRoom(joinRoom, u, r, "join")} loading={roomLoading} error={roomError} />;
  }

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="header-left">
          <span className="app-logo">◈ SyncMusic</span>
          <div className="room-pill">
            <span className={`live-dot ${connected ? "live-dot--on" : "live-dot--off"}`} />
            <span className="room-id-label">Room: {roomId}</span>
          </div>
        </div>
        <div className="header-right">
          {connectionError && <span className="err-badge">{connectionError}</span>}
          <div className="user-pill">{username.slice(0, 1).toUpperCase()}<span>{username}</span></div>
        </div>
      </header>

      <div className="app-body">
        {/* Left: Player */}
        <aside className="panel panel--player">
          <Player
            ref={playerRef}
            socket={socket}
            roomId={roomId}
            song={state}
            userId={userId}
            hostId={state?.hostId}
            onSyncEmit={onSyncEmit}
            onPlaybackChange={onPlaybackChange}
            onNext={goToNextSong}
            onPrev={goToPrevSong}
            isHost={isHost}
          />
          {/* Transport */}
          <div className="transport">
            <button className="transport-btn" onClick={goToPrevSong} title="Previous">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" /></svg>
            </button>
            <button
              className={`transport-btn transport-btn--play ${state.isPlaying ? "transport-btn--pause" : ""}`}
              onClick={handleTogglePlay}
              disabled={!state.songId && queue.length === 0}
            >
              {state.isPlaying
                ? <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6zm8-14v14h4V5z" /></svg>
                : <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
              }
            </button>
            <button className="transport-btn" onClick={goToNextSong} title="Next">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zm2-8.14 4.72 3.14L8 16.14V9.86zM16 6h2v12h-2z" /></svg>
            </button>
          </div>

          {/* Users */}
          <Users users={users} hostId={hostId} currentUserId={userId} onRemoveMember={removeMember} />
        </aside>

        {/* Right: Queue + Search */}
        <main className="panel panel--queue">
          <Queue
            queue={queue}
            currentSongId={state.songId}
            onPlaySong={playSelectedSong}
            onRemoveSong={removeFromQueue}
            onSearch={(close) => (
              <div className="search-container">
                <div className="source-toggle">
                  <button className={searchSource === "full" ? "active" : ""} onClick={() => setSearchSource("full")}>Full Songs</button>
                  <button className={searchSource === "preview" ? "active" : ""} onClick={() => setSearchSource("preview")}>30s Previews</button>
                </div>
                <div className="search-row">
                  <input
                    className="search-input"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    placeholder={`Search ${searchSource === "full" ? "songs" : "previews"}...`}
                  />
                  <button className="search-btn" onClick={handleSearch} disabled={searching}>
                    {searching ? "…" : "Search"}
                  </button>
                </div>
                {results.length === 0 && searchQuery && !searching && (
                  <p className="no-results">No results. Try switching to {searchSource === "full" ? "Previews" : "Full Songs"}.</p>
                )}
                <div className="result-list">
                  {results.map((song) => (
                    <div key={song.songId} className="result-item">
                      <img src={song.thumbnail} alt={song.title} className="result-thumb" />
                      <div className="result-info">
                        <div className="result-title">{song.title}</div>
                        <div className="result-artist">{song.artist}</div>
                      </div>
                      <button
                        className="add-btn"
                        disabled={Boolean(addingSongId)}
                        onClick={() => addSong(song, close)}
                      >
                        {addingSongId === song.songId ? "…" : "+"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          />
        </main>
      </div>
    </div>
  );
}