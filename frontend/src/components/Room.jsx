import { useState } from "react";

const Room = ({ onCreate, onJoin, loading = false, error = "" }) => {
  const [username, setUsername] = useState("");
  const [roomId, setRoomId] = useState("");

  return (
    <div className="landing">
      <h1>Music Sync</h1>
      <p>Listen together in real time.</p>
      <input
        placeholder="Your username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <input placeholder="Room ID (for join)" value={roomId} onChange={(e) => setRoomId(e.target.value)} />
      {error ? <p className="error-text">{error}</p> : null}
      <div className="row">
        <button disabled={loading} onClick={() => onCreate(username, roomId)}>
          {loading ? "Please wait..." : "Create Room"}
        </button>
        <button className="secondary" disabled={loading} onClick={() => onJoin(username, roomId)}>
          {loading ? "Please wait..." : "Join Room"}
        </button>
      </div>
    </div>
  );
};

export default Room;
