import cors from "cors";
import express from "express";
import http from "node:http";
import { nanoid } from "nanoid";
import { Server } from "socket.io";
import { StreamManager } from "./streamManager.js";

const port = Number(process.env.PORT || 5000);
const rtmpServer = process.env.RTMP_SERVER || "rtmp://rtmp:1935/live";
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:3000";

const app = express();
app.use(express.json());
app.use(cors({ origin: corsOrigin }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 1e7
});

const streamManager = new StreamManager({ rtmpServer });
const streamSessions = new Map();
const pulseStore = new Map();

const reactionTypes = new Set(["fire", "wow", "heart", "clap"]);

function roomFor(streamKey) {
  return `stream:${streamKey}`;
}

function ensurePulseData(streamKey) {
  if (!pulseStore.has(streamKey)) {
    pulseStore.set(streamKey, {
      buckets: new Map(),
      activity: []
    });
  }

  return pulseStore.get(streamKey);
}

function serializePulseData(streamKey) {
  const data = ensurePulseData(streamKey);
  return Array.from(data.buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, counts]) => ({ bucket, counts }));
}

function markLive(streamKey, isLive) {
  const entry = streamSessions.get(streamKey);
  if (entry) {
    entry.isLive = isLive;
  } else {
    streamSessions.set(streamKey, { createdAt: Date.now(), isLive });
  }
}

app.get("/health", (_, res) => {
  res.json({ ok: true, ffmpegTarget: rtmpServer });
});

app.post("/api/stream/session", (_, res) => {
  const streamKey = nanoid(12).toLowerCase();
  streamSessions.set(streamKey, { createdAt: Date.now(), isLive: false });

  res.status(201).json({
    streamKey,
    ingestUrl: "rtmp://localhost:1935/live",
    playbackUrl: `http://localhost:8080/hls/${streamKey}.m3u8`
  });
});

app.get("/api/stream/:streamKey/status", (req, res) => {
  const streamKey = String(req.params.streamKey || "");
  const session = streamSessions.get(streamKey);

  res.json({
    streamKey,
    exists: Boolean(session),
    isLive: Boolean(session?.isLive)
  });
});

io.on("connection", (socket) => {
  socket.on("broadcaster:start", ({ streamKey } = {}) => {
    const key = String(streamKey || "").trim().toLowerCase();
    if (!key) {
      socket.emit("error:stream", { message: "Invalid stream key" });
      return;
    }

    streamManager.startStream({
      socketId: socket.id,
      streamKey: key,
      onExit: () => {
        markLive(key, false);
        io.to(roomFor(key)).emit("stream:status", { streamKey: key, isLive: false });
      }
    });

    markLive(key, true);
    socket.join(roomFor(key));
    socket.emit("broadcaster:ready", { streamKey: key });
    io.to(roomFor(key)).emit("stream:status", { streamKey: key, isLive: true });
  });

  socket.on("broadcaster:chunk", (chunk) => {
    streamManager.writeChunk(socket.id, chunk);
  });

  socket.on("broadcaster:stop", () => {
    const streamKey = streamManager.streamKeyFor(socket.id);
    if (streamKey) {
      markLive(streamKey, false);
      io.to(roomFor(streamKey)).emit("stream:status", { streamKey, isLive: false });
    }
    streamManager.stopStream(socket.id);
  });

  socket.on("viewer:join", ({ streamKey } = {}) => {
    const key = String(streamKey || "").trim().toLowerCase();
    if (!key) {
      socket.emit("error:stream", { message: "Missing stream key" });
      return;
    }

    socket.join(roomFor(key));
    const pulse = ensurePulseData(key);
    const status = streamSessions.get(key);

    socket.emit("stream:init", {
      streamKey: key,
      isLive: Boolean(status?.isLive),
      pulses: serializePulseData(key),
      activity: pulse.activity.slice(-20)
    });
  });

  socket.on("viewer:reaction", ({ streamKey, type } = {}) => {
    const key = String(streamKey || "").trim().toLowerCase();
    const safeType = String(type || "").toLowerCase();

    if (!key || !reactionTypes.has(safeType)) {
      return;
    }

    const now = Date.now();
    const bucket = Math.floor(now / 5000) * 5000;
    const pulse = ensurePulseData(key);

    if (!pulse.buckets.has(bucket)) {
      pulse.buckets.set(bucket, { fire: 0, wow: 0, heart: 0, clap: 0 });
    }

    const counts = pulse.buckets.get(bucket);
    counts[safeType] += 1;

    const event = { type: safeType, at: now };
    pulse.activity.push(event);

    if (pulse.activity.length > 200) {
      pulse.activity.splice(0, pulse.activity.length - 200);
    }

    io.to(roomFor(key)).emit("stream:pulse", { bucket, counts });
    io.to(roomFor(key)).emit("stream:activity", event);
  });

  socket.on("disconnect", () => {
    const streamKey = streamManager.streamKeyFor(socket.id);
    if (streamKey) {
      markLive(streamKey, false);
      io.to(roomFor(streamKey)).emit("stream:status", { streamKey, isLive: false });
    }
    streamManager.stopStream(socket.id);
  });
});

server.listen(port, () => {
  console.log(`stream-backend listening on ${port}`);
});
