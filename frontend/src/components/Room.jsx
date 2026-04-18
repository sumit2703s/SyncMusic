import { useState } from "react";

const Room = ({ onCreate, onJoin, loading = false, error = "" }) => {
  const [username, setUsername] = useState("");
  const [roomId, setRoomId] = useState("");

  return (
    <div className="landing">
      <div className="landing-card">
        <div>
          <div className="landing-logo">◈ SyncMusic</div>
          <p className="landing-sub">Listen together, in perfect sync.</p>
        </div>
        <input
          className="landing-input"
          placeholder="Your username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onCreate(username, roomId)}
        />
        <input
          className="landing-input"
          placeholder="Room ID (leave blank to create new)"
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (roomId ? onJoin(username, roomId) : onCreate(username, roomId))}
        />
        {error && <p className="landing-error">{error}</p>}
        <div className="landing-btns">
          <button className="landing-btn-primary" disabled={loading} onClick={() => onCreate(username, roomId)}>
            {loading ? "Please wait…" : "Create Room"}
          </button>
          <button className="landing-btn-secondary" disabled={loading} onClick={() => onJoin(username, roomId)}>
            {loading ? "Please wait…" : "Join Room"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Room;