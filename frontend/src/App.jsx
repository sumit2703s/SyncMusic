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
  nextSongInRoom,
  pauseSongInRoom,
  playSongInRoom,
  prevSongInRoom,
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

  const hostId = useMemo(() => state?.hostId || "", [state]);

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

      if (data.state) {
        setState(data.state);
      }
      if (data.queue) {
        setQueue(data.queue);
      }
      if (data.users) {
        setUsers(data.users);
      }

      const joinPayload = { roomId: nextRoomId, userId, username: cleanUsername };
      const joinCallback = (response) => {
        if (response?.error) {
          console.error("DEBUG: join_room failed", response);
          setRoomError(response.error || "Failed to join room via socket.");
          return;
        }
        console.log("DEBUG: join_room ack", response);
        setState(response.state || {});
        setQueue(response.queue || []);
        setUsers(response.users || []);
      };

      if (socket.connected) {
        socket.emit("join_room", joinPayload, joinCallback);
      } else {
        pendingRoomJoin.current = { payload: joinPayload, callback: joinCallback };
        console.log("DEBUG: Socket not connected yet, pending join_room set", joinPayload);
      }
    } catch (error) {
      const detail = error?.response?.data?.detail;
      setRoomError(typeof detail === "string" ? detail : "Failed to connect to server. Check backend and try again.");
    } finally {
      setRoomLoading(false);
    }
  };

  const handleCreate = (inputUsername, wantedRoomId) => enterRoom(createRoom, inputUsername, wantedRoomId, "create");
  const handleJoin = (inputUsername, wantedRoomId) => enterRoom(joinRoom, inputUsername, wantedRoomId, "join");

  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const pendingRoomJoin = useRef(null);

  useEffect(() => {
    console.log("DEBUG: Setting up socket listeners. Initial status:", socket.connected);
    
    if (socket.connected) {
      setConnected(true);
      setConnectionError("");
    }

    socket.on("connect", () => {
      console.log("DEBUG: Socket 'connect' event. ID:", socket.id);
      setConnected(true);
      setConnectionError("");
      if (pendingRoomJoin.current) {
        console.log("DEBUG: Emitting pending join_room after socket connect", pendingRoomJoin.current.payload);
        socket.emit("join_room", pendingRoomJoin.current.payload, (response) => {
          pendingRoomJoin.current.callback?.(response);
          pendingRoomJoin.current = null;
        });
      }
    });

    socket.on("connect_error", (err) => {
      const msg = err?.message || err?.toString() || "Connection error";
      console.error("DEBUG: Socket 'connect_error':", msg, err);
      setConnected(false);
      setConnectionError(msg);
    });

    socket.on("connect_timeout", () => {
      setConnectionError("Connection timed out");
      setConnected(false);
    });

    socket.on("error", (err) => {
      console.error("DEBUG: Socket 'error':", err);
      setConnectionError(err?.message || "Internal error");
    });

    socket.on("disconnect", (reason) => {
      console.warn("DEBUG: Socket 'disconnect' event. Reason:", reason);
      setConnected(false);
      if (reason === "io server disconnect") {
        setConnectionError("Server closed the connection");
      } else if (reason === "transport close") {
        setConnectionError("Lost connection to server");
      } else {
        setConnectionError(`Disconnected: ${reason}`);
      }
    });
    
    socket.on("room_state", (payload) => {
      setState(payload.state || {});
      setQueue(payload.queue || []);
      setUsers(payload.users || []);
      if (payload.syncTime && payload.state?.songId) {
        socket.emit("sync_time", {
          roomId: payload.roomId,
          timestamp: payload.syncTime,
          isPlaying: payload.state?.isPlaying,
        });
      }
    });

    socket.on("queue_updated", ({ queue: nextQueue }) => setQueue(nextQueue || []));
    socket.on("user_joined", ({ user: joinedUser }) => {
      if (!joinedUser) return;
      setUsers((prev) => {
        if (prev.some((entry) => entry.userId === joinedUser.userId)) return prev;
        return [...prev, joinedUser];
      });
    });
    socket.on("user_left", ({ users: nextUsers }) => setUsers(nextUsers || []));
    socket.on("song_changed", ({ state: nextState, queue: nextQueue }) => {
      setState(nextState || {});
      if (nextQueue) setQueue(nextQueue);
    });
    socket.on("song_paused", ({ state: nextState }) => setState(nextState || {}));
    socket.on("song_restarted", ({ state: nextState }) => setState(nextState || {}));
    socket.on("host_changed", ({ hostId: nextHost }) => setState((prev) => ({ ...prev, hostId: nextHost })));
    socket.on("kicked", ({ roomId: kickedRoomId }) => {
      if (kickedRoomId && kickedRoomId !== roomId) return;
      alert("You were removed from the room by host.");
      setJoined(false);
      setRoomId("");
      setQueue([]);
      setUsers([]);
      setState({});
    });

    return () => {
      socket.off("room_state");
      socket.off("queue_updated");
      socket.off("user_joined");
      socket.off("user_left");
      socket.off("song_changed");
      socket.off("song_paused");
      socket.off("song_restarted");
      socket.off("host_changed");
      socket.off("kicked");
    };
  }, [socket, roomId]);

  const [searching, setSearching] = useState(false);
  const [addingSongId, setAddingSongId] = useState("");
  const [searchSource, setSearchSource] = useState("full"); // Default to full songs as requested

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

  const addSong = (song, onAdded) => {
    if (!roomId) {
      alert("Room ID is missing. Please create or join a room before adding songs.");
      return;
    }

    if (!song?.songId || addingSongId) return;
    setAddingSongId(song.songId);
    console.log(`DEBUG: Adding song to room ${roomId} via socket ${socket.id}`, song);
    addSongToQueue(roomId, song)
      .then((result) => {
        if (Array.isArray(result?.queue)) {
          setQueue(result.queue);
        } else {
          setQueue((prev) => [...prev, song]);
        }

        if (!state.songId && socket.connected) {
          console.log("DEBUG: Triggering initial play");
          socket.emit("play_song", { roomId, song, timestamp: 0 }, (response) => {
            if (response?.error) {
              console.error("DEBUG: play_song failed", response);
            }
          });
        }

        setResults([]);
        onAdded();
      })
      .catch((error) => {
        const detail = error?.response?.data?.detail || error?.message || "Unknown error";
        alert(`Failed to add song: ${detail}`);
      })
      .finally(() => {
        setAddingSongId("");
      });
  };

  const playSelectedSong = (song) => {
    if (!roomId || !song?.songId) return;
    playSongInRoom(roomId, song, 0)
      .catch((error) => {
        const detail = error?.response?.data?.detail || error?.message || "Unknown error";
        alert(`Failed to play song: ${detail}`);
      });
  };

  const removeMember = (member) => {
    if (!roomId || !member?.userId) return;
    kickMember(roomId, userId, member.userId)
      .then((response) => {
        if (Array.isArray(response?.users)) {
          setUsers(response.users);
        }
      })
      .catch((error) => {
        const detail = error?.response?.data?.detail || error?.message || "Unknown error";
        alert(`Failed to remove member: ${detail}`);
      });
  };

  const onSyncEmit = (timestamp, isPlaying) => {
    if (!roomId) return;
    socket.emit("sync_time", { roomId, timestamp, isPlaying });
  };

  const onPlaybackChange = (type, timestamp) => {
    if (!roomId) return;
    if (type === "play") {
      if (!state.songId) return;
      playSongInRoom(
        roomId,
        {
          ...state,
          durationSec: state.durationSec || 30,
        },
        timestamp
      ).catch((error) => {
        const detail = error?.response?.data?.detail || error?.message || "Unknown error";
        console.error("Play failed:", detail);
      });
    } else {
      pauseSongInRoom(roomId, timestamp).catch((error) => {
        const detail = error?.response?.data?.detail || error?.message || "Unknown error";
        console.error("Pause failed:", detail);
      });
    }
  };

  const playerRef = useRef(null);

  const handleTogglePlay = () => {
    if (!roomId) return;
    
    // If no song is loaded but we have a queue, play the first song
    if (!state.songId && queue.length > 0) {
      playSelectedSong(queue[0]);
      return;
    }

    if (!state.songId) return;

    const nextIsPlaying = !state.isPlaying;
    
    // Optimistic UI update
    setState(prev => ({ ...prev, isPlaying: nextIsPlaying }));

    if (nextIsPlaying) {
      playerRef.current?.play();
    } else {
      playerRef.current?.pause();
    }
  };

  if (!joined) {
    return <Room onCreate={handleCreate} onJoin={handleJoin} loading={roomLoading} error={roomError} />;
  }

  return (
    <div className="app">
      <header>
        <div className="row align-center">
          <div className="row align-center">
            <h2>Room: {roomId}</h2>
            <span className={`status-dot ${connected ? "online" : "offline"}`} title={connected ? "Connected" : "Disconnected"}></span>
            {connectionError && <small className="error-text" style={{ marginLeft: "10px" }}>{connectionError}</small>}
            {!connected && !connectionError && <small className="muted" style={{ marginLeft: "10px" }}>Connecting to backend...</small>}
          </div>
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
                    Full Songs (YouTube)
                  </button>
                </div>
                <div className="search-input-group row">
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    placeholder={searchSource === "full" ? "Search full songs (YouTube)..." : "Search previews (Deezer)..."}
                  />
                  <button onClick={handleSearch} disabled={searching} className="primary-btn">
                    {searching ? "..." : "Search"}
                  </button>
                </div>
                <div className="results">
                  {results.length === 0 && searchQuery && !searching && (
                    <div className="muted" style={{ padding: "20px", textAlign: "center", background: "#111", borderRadius: "10px" }}>
                      <p>No results found in <b>{searchSource === "full" ? "YouTube" : "Previews"}</b>.</p>
                      <button 
                        className="secondary" 
                        style={{ marginTop: "10px" }}
                        onClick={() => {
                          setSearchSource(searchSource === "full" ? "preview" : "full");
                          setTimeout(handleSearch, 100);
                        }}
                      >
                        Try searching in {searchSource === "full" ? "Previews" : "Full Songs"}
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
        <button
          className="control-btn secondary"
          onClick={() =>
            prevSongInRoom(roomId).catch((error) => {
              const detail = error?.response?.data?.detail || error?.message || "Unknown error";
              alert(`Prev failed: ${detail}`);
            })
          }
        >
          Prev
        </button>
        <button
          className={`control-btn play-pause-btn ${state.isPlaying ? "playing" : ""}`}
          onClick={handleTogglePlay}
          disabled={!state.songId && queue.length === 0}
        >
          {state.isPlaying ? "Pause" : "Play"}
        </button>
        <button
          className="control-btn secondary"
          onClick={() =>
            nextSongInRoom(roomId).catch((error) => {
              const detail = error?.response?.data?.detail || error?.message || "Unknown error";
              alert(`Next failed: ${detail}`);
            })
          }
        >
          Next
        </button>
      </footer>
    </div>
  );
};

export default App;
