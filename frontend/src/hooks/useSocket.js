import { useEffect, useMemo } from "react";
import { io } from "socket.io-client";

export const useSocket = () => {
  const socket = useMemo(() => {
    const isProd = typeof window !== "undefined" && !window.location.hostname.includes("localhost") && !window.location.hostname.includes("127.0.0.1");
    
    let url = import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_BACKEND_URL;
    
    if (!url) {
      const hostname = typeof window !== "undefined" ? window.location.hostname : "localhost";
      // Only default to port 8000 if we are clearly on localhost
      if (hostname.includes("localhost") || hostname.includes("127.0.0.1")) {
        url = `http://${hostname}:8000`;
      } else {
        // In production, if variables are missing, we try to guess the Render URL or at least warn
        console.error("VITE_SOCKET_URL/VITE_BACKEND_URL is missing in production environment variables!");
        url = window.location.origin.replace("vercel.app", "onrender.com"); // Hail mary guess for Render common pattern
      }
    }
    
    // Ensure URL has a protocol
    if (url && !url.startsWith("http")) {
      url = `${window.location.protocol}//${url}`;
    }

    console.log(`Connecting to socket at: ${url} (Origin: ${window.location.origin})`);
    
    return io(url, {
      autoConnect: true,
      transports: ["websocket"],
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
