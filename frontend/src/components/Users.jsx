const Users = ({ users = [], hostId, currentUserId, onRemoveMember }) => {
  return (
    <div className="card users-card">
      <h3>Connected Users</h3>
      <div className="users-list">
        {users.map((user) => (
          <div key={user.userId} className="user-item">
            <div className="row user-row">
              <div className="avatar">{user.username?.slice(0, 1)?.toUpperCase() || "G"}</div>
              <span>
                {user.username} {hostId === user.userId ? "(Host)" : ""}
              </span>
            </div>
            {hostId === currentUserId && user.userId !== currentUserId ? (
              <button className="secondary remove-btn" onClick={() => onRemoveMember?.(user)}>
                Remove
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
};

export default Users;
