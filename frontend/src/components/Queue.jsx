import { useState } from "react";

const Queue = ({ queue = [], onSearch, onPlaySong, currentSongId }) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="card queue-card">
      <div className="row space-between">
        <h3>Queue</h3>
        <button onClick={() => setOpen(!open)}>Add Song</button>
      </div>
      <div className="queue-list">
        {queue.length === 0 ? (
          <p className="muted">No songs queued yet.</p>
        ) : (
          queue.map((song, index) => (
            <div key={`${song.songId}-${index}`} className="queue-item">
              <img src={song.thumbnail} alt={song.title} />
              <div>
                <div>{song.title}</div>
                <small>{song.artist}</small>
              </div>
              <div className="row">
                <small>{song.duration}</small>
                <button
                  className="secondary"
                  disabled={currentSongId === song.songId}
                  onClick={() => onPlaySong?.(song)}
                >
                  {currentSongId === song.songId ? "Playing" : "Play"}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      {open && (
        <div className="search-modal">
          <button className="close" onClick={() => setOpen(false)}>
            x
          </button>
          {onSearch(() => setOpen(false))}
        </div>
      )}
    </div>
  );
};

export default Queue;
