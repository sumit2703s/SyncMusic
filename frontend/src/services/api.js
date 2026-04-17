import axios from "axios";

// Priority: VITE_BACKEND_URL -> VITE_SOCKET_URL -> localhost
const baseURL = import.meta.env.VITE_BACKEND_URL || import.meta.env.VITE_SOCKET_URL || "http://localhost:8000";

export const api = axios.create({
  baseURL,
  timeout: 30000, // YouTube extraction can be slow
});

// Global error interceptor
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const detail = error.response?.data?.detail || error.message;
    console.error(`API Error (${error.config?.url}):`, detail);
    return Promise.reject(error);
  }
);

export const createRoom = async ({ roomId, userId, username }) => {
  const { data } = await api.post("/api/rooms/create", { roomId, userId, username });
  return data;
};

export const joinRoom = async ({ roomId, userId, username }) => {
  const { data } = await api.post("/api/rooms/join", { roomId, userId, username });
  return data;
};

export const addSongToQueue = async (roomId, song) => {
  const { data } = await api.post(`/api/rooms/${roomId}/queue`, { song });
  return data;
};

export const playSongInRoom = async (roomId, song, timestamp = 0) => {
  const { data } = await api.post(`/api/rooms/${roomId}/play`, { song, timestamp });
  return data;
};

export const pauseSongInRoom = async (roomId, timestamp = 0) => {
  const { data } = await api.post(`/api/rooms/${roomId}/pause`, { timestamp });
  return data;
};

export const nextSongInRoom = async (roomId) => {
  const { data } = await api.post(`/api/rooms/${roomId}/next`);
  return data;
};

export const prevSongInRoom = async (roomId) => {
  const { data } = await api.post(`/api/rooms/${roomId}/prev`);
  return data;
};

export const kickMember = async (roomId, byUserId, targetUserId) => {
  const { data } = await api.post(`/api/rooms/${roomId}/kick`, { byUserId, targetUserId });
  return data;
};

export const searchMusic = async (q, source = "preview") => {
  try {
    const { data } = await api.get("/api/search", { params: { q, limit: 12, source } });
    return data.results || [];
  } catch (error) {
    return [];
  }
};

export const resolveSong = async (songId) => {
  // songId format is typically "yt-VIDEOID"
  const videoId = songId.startsWith("yt-") ? songId.replace("yt-", "") : songId;
  const { data } = await api.get(`/api/resolve/${videoId}`);
  return data.url;
};
