import { useEffect, useMemo } from "react";
import { io } from "socket.io-client";

export const useSocket = () => {
  const socket = useMemo(() => {
    // Priority: VITE_SOCKET_URL -> VITE_BACKEND_URL -> localhost
    const hostname = typeof window !== "undefined" ? window.location.hostname : "localhost";
    const url = import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_BACKEND_URL || `http://${hostname}:8000`;
    
    console.log(`Connecting to socket at: ${url} (Origin: ${window.location.origin})`);
    
    return io(url, {
      autoConnect: true,
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      withCredentials: true,
    });
  }, []);

  useEffect(() => {
    socket.on("connect", () => console.log("Socket connected:", socket.id));
    socket.on("connect_error", (err) => console.error("Socket connection error:", err.message));
    
    // We don't disconnect on cleanup because useMemo keeps the socket object stable
    // and we want it to survive React's double-mounting in development.
    return () => {
      socket.off("connect");
      socket.off("connect_error");
    };
  }, [socket]);

  return socket;
};
