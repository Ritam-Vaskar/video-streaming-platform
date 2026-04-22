import cors from "cors";
import express from "express";
import http from "node:http";
import { nanoid } from "nanoid";
import fs from "node:fs/promises";
import path from "node:path";
import { Server } from "socket.io";
import { AuthService, isBroadcasterRole } from "./auth.js";
import { generateHighlights } from "./highlightService.js";
import { StreamManager } from "./streamManager.js";

const port = Number(process.env.PORT || 5000);
const abrRtmpTarget = process.env.RTMP_ABR_TARGET || "rtmp://rtmp:1935/hls";
const recordRtmpTarget = process.env.RTMP_RECORD_TARGET || "rtmp://rtmp:1935/live";
const youtubeRtmpBase = process.env.YOUTUBE_RTMP_BASE || "rtmp://a.rtmp.youtube.com/live2";
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:3000";
const highlightsDir = process.env.HIGHLIGHTS_DIR || "/app/media/highlights";
const publicRtmpIngestUrl = process.env.PUBLIC_RTMP_INGEST_URL || "rtmp://localhost:1935/live";
const publicHlsBaseUrl = process.env.PUBLIC_HLS_BASE_URL || "http://localhost:8080/hls";

const app = express();
app.use(express.json());
app.use(cors({ origin: corsOrigin }));
app.use("/media/highlights", express.static(highlightsDir));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 1e7
});

const authService = new AuthService();
await authService.init();
await fs.mkdir(highlightsDir, { recursive: true });

const streamManager = new StreamManager({
  abrRtmpTarget,
  recordRtmpTarget,
  youtubeRtmpBase
});
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
    if (isLive) {
      entry.startedAt = Date.now();
    }
  } else {
    streamSessions.set(streamKey, { createdAt: Date.now(), isLive });
  }
}

function sessionFor(streamKey) {
  if (!streamSessions.has(streamKey)) {
    streamSessions.set(streamKey, {
      createdAt: Date.now(),
      isLive: false,
      startedAt: null,
      highlights: [],
      highlightJobRunning: false,
      youtubeKey: "",
      ownerId: null
    });
  }
  return streamSessions.get(streamKey);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function finalizeHighlights(streamKey) {
  const session = streamSessions.get(streamKey);
  if (!session?.startedAt) {
    return;
  }

  if (session.highlightJobRunning) {
    return;
  }

  session.highlightJobRunning = true;

  try {
    await delay(2000);

    const pulse = ensurePulseData(streamKey);
    const highlights = await generateHighlights({
      streamKey,
      streamStartedAt: session.startedAt,
      pulseBucketsMap: pulse.buckets
    });

    session.highlights = highlights;
    io.to(roomFor(streamKey)).emit("stream:highlights", { streamKey, highlights });
  } finally {
    session.highlightJobRunning = false;
  }
}

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    ffmpegTarget: abrRtmpTarget,
    recordTarget: recordRtmpTarget,
    playbackBase: publicHlsBaseUrl
  });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password, role } = req.body || {};
    const user = await authService.register({ email, password, role });
    return res.status(201).json({ user });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const result = await authService.login({ email, password });
    return res.json(result);
  } catch {
    return res.status(401).json({ message: "Invalid credentials" });
  }
});

app.get("/api/auth/me", authService.authMiddleware(), (req, res) => {
  res.json({
    user: {
      id: req.user.sub,
      email: req.user.email,
      role: req.user.role
    }
  });
});

app.post("/api/stream/session", authService.authMiddleware({ roles: ["broadcaster", "admin"] }), (req, res) => {
  const { youtubeKey = "" } = req.body || {};
  const streamKey = nanoid(12).toLowerCase();
  streamSessions.set(streamKey, {
    createdAt: Date.now(),
    startedAt: null,
    isLive: false,
    ownerId: req.user.sub,
    youtubeKey: String(youtubeKey || "").trim(),
    highlights: [],
    highlightJobRunning: false
  });

  res.status(201).json({
    streamKey,
    ingestUrl: publicRtmpIngestUrl,
    playbackUrl: `${publicHlsBaseUrl}/${streamKey}.m3u8`,
    youtubeIngestBase: youtubeRtmpBase
  });
});

app.get("/api/stream/:streamKey/status", (req, res) => {
  const streamKey = String(req.params.streamKey || "");
  const session = streamSessions.get(streamKey);

  res.json({
    streamKey,
    exists: Boolean(session),
    isLive: Boolean(session?.isLive),
    highlights: session?.highlights || []
  });
});

app.get("/api/stream/:streamKey/highlights", (req, res) => {
  const streamKey = String(req.params.streamKey || "").trim().toLowerCase();
  const session = streamSessions.get(streamKey);

  res.json({
    streamKey,
    highlights: session?.highlights || []
  });
});

io.on("connection", (socket) => {
  const user = authService.socketUser(socket);

  socket.on("broadcaster:start", ({ streamKey, youtubeKey } = {}) => {
    if (!user || !isBroadcasterRole(user.role)) {
      socket.emit("error:stream", { message: "Broadcaster role required" });
      return;
    }

    const key = String(streamKey || "").trim().toLowerCase();
    if (!key) {
      socket.emit("error:stream", { message: "Invalid stream key" });
      return;
    }

    const session = sessionFor(key);
    const normalizedYoutubeKey = String(youtubeKey || "").trim();
    if (normalizedYoutubeKey) {
      session.youtubeKey = normalizedYoutubeKey;
    }

    if (session.ownerId && session.ownerId !== user.sub && user.role !== "admin") {
      socket.emit("error:stream", { message: "You do not own this stream key" });
      return;
    }

    session.ownerId = user.sub;

    streamManager.startStream({
      socketId: socket.id,
      streamKey: key,
      youtubeKey: session.youtubeKey,
      onExit: (code) => {
        markLive(key, false);
        io.to(roomFor(key)).emit("stream:status", { streamKey: key, isLive: false });
        if (code !== 0) {
          socket.emit("error:stream", {
            message: "Primary stream process exited unexpectedly. Check stream settings and try again."
          });
        }
        finalizeHighlights(key).catch((error) => {
          console.error(`highlight generation failed for ${key}:`, error.message);
        });
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
      finalizeHighlights(streamKey).catch((error) => {
        console.error(`highlight generation failed for ${streamKey}:`, error.message);
      });
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
      activity: pulse.activity.slice(-20),
      highlights: status?.highlights || []
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
      finalizeHighlights(streamKey).catch((error) => {
        console.error(`highlight generation failed for ${streamKey}:`, error.message);
      });
    }
    streamManager.stopStream(socket.id);
  });
});

server.listen(port, () => {
  console.log(`stream-backend listening on ${port}`);
});
