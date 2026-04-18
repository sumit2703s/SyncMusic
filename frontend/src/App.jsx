import { useEffect, useMemo, useRef, useState } from "react";

import Player from "./components/Player";
import Queue from "./components/Queue";
import Room from "./components/Room";
import Users from "./components/Users";
import { useSocket } from "./hooks/useSocket";
import {
  addSongToQueue,
  createRoom,
  joinRoom,
  kickMember,
  pauseSongInRoom,
  playSongInRoom,
  searchMusic,
} from "./services/api";

const randomId = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;

const App = () => {
  const socket = useSocket();
  const [userId] = useState(() => randomId());
  const [username, setUsername] = useState("");
  const [roomId, setRoomId] = useState("");
  const [joined, setJoined] = useState(false);
  const [queue, setQueue] = useState([]);
  const [users, setUsers] = useState([]);
  const [state, setState] = useState({});
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState([]);
  const [roomLoading, setRoomLoading] = useState(false);
  const [roomError, setRoomError] = useState("");
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const pendingRoomJoin = useRef(null);

  const hostId = useMemo(() => state?.hostId || "", [state]);

  // ── Room join / create ───────────────────────────────────────────────
  const enterRoom = async (fn, inputUsername, inputRoomId, mode) => {
    const cleanUsername = inputUsername?.trim() || `Guest-${String(userId).slice(0, 4)}`;
    const cleanRoomId = inputRoomId?.trim() || "";

    if (mode === "join" && !cleanRoomId) {
      setRoomError("Enter a Room ID to join.");
      return;
    }

    setRoomError("");
    setRoomLoading(true);
    try {
      setUsername(cleanUsername);
      const data = await fn({ roomId: cleanRoomId, userId, username: cleanUsername });
      const nextRoomId = data.roomId || cleanRoomId;
      if (!nextRoomId) {
        setRoomError("Could not determine room ID. Please try again.");
        return;
      }
      setRoomId(nextRoomId);
      setJoined(true);
      if (data.state) setState(data.state);
      if (data.queue) setQueue(data.queue);
      if (data.users) setUsers(data.users);

      const joinPayload = { roomId: nextRoomId, userId, username: cleanUsername };
      const joinCallback = (response) => {
        if (response?.error) {
          setRoomError(response.error || "Failed to join room via socket.");
          return;
        }
        setState(response.state || {});
        setQueue(response.queue || []);
        setUsers(response.users || []);
      };

      if (socket.connected) {
        socket.emit("join_room", joinPayload, joinCallback);
      } else {
        pendingRoomJoin.current = { payload: joinPayload, callback: joinCallback };
      }
    } catch (error) {
      const detail = error?.response?.data?.detail;
      setRoomError(typeof detail === "string" ? detail : "Failed to connect. Check backend and try again.");
    } finally {
      setRoomLoading(false);
    }
  };

  const handleCreate = (u, r) => enterRoom(createRoom, u, r, "create");
  const handleJoin = (u, r) => enterRoom(joinRoom, u, r, "join");

  // ── Socket listeners ──────────────────────────────────────────────────
  useEffect(() => {
    if (socket.connected) { setConnected(true); setConnectionError(""); }

    socket.on("connect", () => {
      setConnected(true);
      setConnectionError("");
      if (pendingRoomJoin.current) {
        socket.emit("join_room", pendingRoomJoin.current.payload, (res) => {
          pendingRoomJoin.current.callback?.(res);
          pendingRoomJoin.current = null;
        });
      }
    });
    socket.on("connect_error", (err) => {
      setConnected(false);
      setConnectionError(err?.message || "Connection error");
    });
    socket.on("disconnect", (reason) => {
      setConnected(false);
      setConnectionError(reason === "io server disconnect" ? "Server closed the connection" : `Disconnected: ${reason}`);
    });

    socket.on("room_state", (payload) => {
      setState(payload.state || {});
      setQueue(payload.queue || []);
      setUsers(payload.users || []);
      if (payload.syncTime && payload.state?.songId) {
        socket.emit("sync_time", {
          roomId: payload.roomId,
          songId: payload.state.songId,
          timestamp: payload.syncTime,
          isPlaying: payload.state?.isPlaying,
        });
      }
    });

    socket.on("queue_updated", ({ queue: q }) => setQueue(q || []));
    socket.on("user_joined", ({ user: u }) => {
      if (!u) return;
      setUsers((prev) => prev.some((x) => x.userId === u.userId) ? prev : [...prev, u]);
    });
    socket.on("user_left", ({ users: u }) => setUsers(u || []));
    socket.on("song_changed", ({ state: s, queue: q }) => {
      setState(s || {});
      if (q) setQueue(q);
    });
    socket.on("song_paused", ({ state: s }) => setState(s || {}));
    socket.on("song_restarted", ({ state: s }) => setState(s || {}));
    socket.on("host_changed", ({ hostId: h }) => setState((prev) => ({ ...prev, hostId: h })));
    socket.on("queue_empty", () => {
      // Queue finished — clear the player
      setState((prev) => ({ ...prev, songId: null, isPlaying: false }));
    });
    socket.on("kicked", ({ roomId: kickedRoom }) => {
      if (kickedRoom && kickedRoom !== roomId) return;
      alert("You were removed from the room.");
      setJoined(false); setRoomId(""); setQueue([]); setUsers([]); setState({});
    });

    return () => {
      ["room_state", "queue_updated", "user_joined", "user_left", "song_changed",
        "song_paused", "song_restarted", "host_changed", "queue_empty", "kicked"].forEach((e) => socket.off(e));
    };
  }, [socket, roomId]);

  // ── Search ────────────────────────────────────────────────────────────
  const [searching, setSearching] = useState(false);
  const [addingSongId, setAddingSongId] = useState("");
  const [searchSource, setSearchSource] = useState("full");

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const data = await searchMusic(searchQuery.trim(), searchSource);
      setResults(data);
    } finally {
      setSearching(false);
    }
  };

  // ── Add song to queue ────────────────────────────────────────────────
  const addSong = (song, onAdded) => {
    if (!roomId) { alert("Join a room first."); return; }
    if (!song?.songId || addingSongId) return;

    setAddingSongId(song.songId);
    addSongToQueue(roomId, song)
      .then((result) => {
        if (Array.isArray(result?.queue)) setQueue(result.queue);
        else setQueue((prev) => [...prev, song]);

        // If nothing is playing yet, play this song immediately via socket
        if (!state.songId && socket.connected) {
          socket.emit("play_song", { roomId, song, timestamp: 0 }, (res) => {
            if (res?.error) console.error("play_song failed", res);
          });
        }

        setResults([]);
        onAdded();
      })
      .catch((err) => alert(`Failed to add song: ${err?.response?.data?.detail || err?.message}`))
      .finally(() => setAddingSongId(""));
  };

  // ── Play a specific song (from queue click) ───────────────────────────
  const playSelectedSong = (song) => {
    if (!roomId || !song?.songId) return;
    // Use socket so all room members get the update
    socket.emit("play_song", { roomId, song, timestamp: 0 }, (res) => {
      if (res?.error) alert(`Failed to play song: ${res.error}`);
    });
  };

  // ── Next / Prev via socket (NOT HTTP) ─────────────────────────────────
  const goToNextSong = () => {
    if (!roomId) return;
    socket.emit("next_song", { roomId }, (res) => {
      if (res?.error) console.error("next_song failed", res);
    });
  };

  const goToPrevSong = () => {
    if (!roomId) return;
    socket.emit("prev_song", { roomId }, (res) => {
      if (res?.error) console.error("prev_song failed", res);
    });
  };

  // ── Auto-replace song when YouTube fails → play preview version ───────
  const handleSongReplace = (fallbackSong) => {
    if (!roomId || !fallbackSong?.songId) return;
    console.log("DEBUG: Auto-replacing with preview:", fallbackSong.title);
    socket.emit("play_song", { roomId, song: fallbackSong, timestamp: 0 });
  };

  // ── Sync emit (heartbeat) ─────────────────────────────────────────────
  const onSyncEmit = (timestamp, isPlaying, songId) => {
    if (!roomId || !songId) return;
    socket.emit("sync_time", { roomId, songId, timestamp, isPlaying });
  };

  // ── Play/Pause changes from local audio element ───────────────────────
  const onPlaybackChange = (type, timestamp, songId) => {
    if (!roomId || !songId) return;
    if (type === "play") {
      playSongInRoom(roomId, { ...state, songId, durationSec: state.durationSec || 30 }, timestamp)
        .catch((e) => console.error("Play failed:", e?.response?.data?.detail || e?.message));
    } else {
      pauseSongInRoom(roomId, timestamp)
        .catch((e) => console.error("Pause failed:", e?.response?.data?.detail || e?.message));
    }
  };

  // ── Toggle play/pause ─────────────────────────────────────────────────
  const playerRef = useRef(null);

  const handleTogglePlay = () => {
    if (!roomId) return;
    if (!state.songId && queue.length > 0) { playSelectedSong(queue[0]); return; }
    if (!state.songId) return;

    const nextPlaying = !state.isPlaying;
    setState((prev) => ({ ...prev, isPlaying: nextPlaying }));
    if (nextPlaying) playerRef.current?.play();
    else playerRef.current?.pause();
  };

  // ── Remove member ─────────────────────────────────────────────────────
  const removeMember = (member) => {
    if (!roomId || !member?.userId) return;
    kickMember(roomId, userId, member.userId)
      .then((res) => { if (Array.isArray(res?.users)) setUsers(res.users); })
      .catch((e) => alert(`Failed to remove: ${e?.response?.data?.detail || e?.message}`));
  };

  if (!joined) {
    return <Room onCreate={handleCreate} onJoin={handleJoin} loading={roomLoading} error={roomError} />;
  }

  return (
    <div className="app">
      <header>
        <div className="row align-center">
          <h2>Room: {roomId}</h2>
          <span
            className={`status-dot ${connected ? "online" : "offline"}`}
            title={connected ? "Connected" : "Disconnected"}
          />
          {connectionError && (
            <small className="error-text" style={{ marginLeft: 10 }}>{connectionError}</small>
          )}
        </div>
        <div className="chip">{username}</div>
      </header>

      <main>
        <section className="left">
          <Player
            ref={playerRef}
            socket={socket}
            roomId={roomId}
            song={state}
            onSyncEmit={onSyncEmit}
            onPlaybackChange={onPlaybackChange}
            onSongReplace={handleSongReplace}
            onNext={goToNextSong}
            isHost={userId === hostId}
          />
        </section>
        <section className="right">
          <Users users={users} hostId={hostId} currentUserId={userId} onRemoveMember={removeMember} />
          <Queue
            queue={queue}
            currentSongId={state.songId}
            onPlaySong={playSelectedSong}
            onSearch={(close) => (
              <div className="search-container">
                <div className="source-toggle row">
                  <button
                    className={searchSource === "preview" ? "active" : ""}
                    onClick={() => setSearchSource("preview")}
                  >
                    Short Previews
                  </button>
                  <button
                    className={searchSource === "full" ? "active" : ""}
                    onClick={() => setSearchSource("full")}
                  >
                    Full Songs
                  </button>
                </div>
                <div className="search-input-group row">
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    placeholder={searchSource === "full" ? "Search songs..." : "Search previews..."}
                  />
                  <button onClick={handleSearch} disabled={searching} className="primary-btn">
                    {searching ? "..." : "Search"}
                  </button>
                </div>
                <div className="results">
                  {results.length === 0 && searchQuery && !searching && (
                    <div className="muted" style={{ padding: 20, textAlign: "center", background: "#111", borderRadius: 10 }}>
                      <p>No results found.</p>
                      <button
                        className="secondary"
                        style={{ marginTop: 10 }}
                        onClick={() => {
                          setSearchSource(searchSource === "full" ? "preview" : "full");
                          setTimeout(handleSearch, 100);
                        }}
                      >
                        Try {searchSource === "full" ? "Previews" : "Full Songs"}
                      </button>
                    </div>
                  )}
                  {results.map((song) => (
                    <div key={song.songId} className="result-item">
                      <img src={song.thumbnail} alt={song.title} />
                      <div style={{ flex: 1 }}>
                        <div className="song-title">{song.title}</div>
                        <small className="muted">{song.artist}</small>
                      </div>
                      <button disabled={Boolean(addingSongId)} onClick={() => addSong(song, close)}>
                        {addingSongId === song.songId ? "Adding..." : "Add"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          />
        </section>
      </main>

      <footer className="player-bar">
        <button className="control-btn secondary" onClick={goToPrevSong}>Prev</button>
        <button
          className={`control-btn play-pause-btn ${state.isPlaying ? "playing" : ""}`}
          onClick={handleTogglePlay}
          disabled={!state.songId && queue.length === 0}
        >
          {state.isPlaying ? "Pause" : "Play"}
        </button>
        <button className="control-btn secondary" onClick={goToNextSong}>Next</button>
      </footer>
    </div>
  );
};

export default App;