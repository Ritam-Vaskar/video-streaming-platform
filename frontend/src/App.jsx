import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import { io } from "socket.io-client";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:5000";
const HLS_BASE = import.meta.env.VITE_HLS_URL || "http://localhost:8080/hls";
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "http://localhost:5000";

const reactions = [
  { key: "fire", label: "Fire", icon: "F" },
  { key: "wow", label: "Wow", icon: "W" },
  { key: "heart", label: "Heart", icon: "H" },
  { key: "clap", label: "Clap", icon: "C" }
];

function getPulseWeight(counts) {
  return counts.fire * 4 + counts.wow * 3 + counts.heart * 2 + counts.clap;
}

function PulseBars({ pulses }) {
  const bars = useMemo(() => {
    const last = pulses.slice(-16);
    const max = Math.max(1, ...last.map((entry) => getPulseWeight(entry.counts)));
    return last.map((entry) => ({
      ...entry,
      level: Math.max(8, Math.round((getPulseWeight(entry.counts) / max) * 100))
    }));
  }, [pulses]);

  if (!bars.length) {
    return <div className="empty-block">No audience pulses yet. Invite viewers to react.</div>;
  }

  return (
    <div className="pulse-bars" aria-label="Audience pulse timeline">
      {bars.map((bar) => (
        <div key={bar.bucket} className="pulse-column">
          <div className="pulse-bar" style={{ height: `${bar.level}%` }} />
          <span>{new Date(bar.bucket).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" })}</span>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState("broadcaster");
  const [streamKey, setStreamKey] = useState("");
  const [generated, setGenerated] = useState(null);
  const [broadcasting, setBroadcasting] = useState(false);
  const [liveStatus, setLiveStatus] = useState(false);
  const [error, setError] = useState("");
  const [activity, setActivity] = useState([]);
  const [pulses, setPulses] = useState([]);

  const localVideoRef = useRef(null);
  const viewerVideoRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const socketRef = useRef(null);
  const hlsRef = useRef(null);

  useEffect(() => {
    return () => {
      stopBroadcast();
      stopViewer();
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  function ensureSocket() {
    if (!socketRef.current) {
      socketRef.current = io(SOCKET_URL, { transports: ["websocket"] });

      socketRef.current.on("connect_error", () => {
        setError("Socket connection failed. Check backend availability.");
      });

      socketRef.current.on("stream:init", (payload) => {
        setLiveStatus(Boolean(payload.isLive));
        setPulses(payload.pulses || []);
        setActivity(payload.activity || []);
      });

      socketRef.current.on("stream:status", ({ isLive }) => {
        setLiveStatus(Boolean(isLive));
      });

      socketRef.current.on("stream:pulse", ({ bucket, counts }) => {
        setPulses((prev) => {
          const next = prev.filter((entry) => entry.bucket !== bucket);
          next.push({ bucket, counts });
          return next.sort((a, b) => a.bucket - b.bucket);
        });
      });

      socketRef.current.on("stream:activity", (event) => {
        setActivity((prev) => [...prev.slice(-29), event]);
      });

      socketRef.current.on("error:stream", ({ message }) => {
        setError(message || "A stream error occurred.");
      });
    }

    return socketRef.current;
  }

  async function createSession() {
    setError("");
    const response = await fetch(`${API_BASE}/api/stream/session`, {
      method: "POST"
    });

    if (!response.ok) {
      throw new Error("Failed to create stream session");
    }

    const session = await response.json();
    setGenerated(session);
    setStreamKey(session.streamKey);
  }

  async function startCamera() {
    setError("");
    const media = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, frameRate: 30 },
      audio: true
    });
    mediaStreamRef.current = media;

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = media;
      localVideoRef.current.play().catch(() => null);
    }
  }

  async function startBroadcast() {
    setError("");
    if (!streamKey) {
      setError("Create or enter a stream key first.");
      return;
    }

    if (!mediaStreamRef.current) {
      await startCamera();
    }

    const socket = ensureSocket();
    socket.emit("broadcaster:start", { streamKey });

    const options = [
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9,opus",
      "video/webm"
    ];

    const mimeType = options.find((item) => MediaRecorder.isTypeSupported(item)) || "video/webm";

    const recorder = new MediaRecorder(mediaStreamRef.current, {
      mimeType,
      videoBitsPerSecond: 1_500_000
    });

    let sendChain = Promise.resolve();
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) {
        return;
      }

      const blob = event.data;
      sendChain = sendChain
        .then(() => blob.arrayBuffer())
        .then((buffer) => {
          if (socket.connected) {
            socket.emit("broadcaster:chunk", buffer);
          }
        })
        .catch(() => {
          setError("Chunk upload failed. Please restart the stream.");
        });
    };

    recorder.onerror = () => {
      setError("Recorder error occurred while broadcasting.");
    };

    recorder.start(250);
    mediaRecorderRef.current = recorder;
    setBroadcasting(true);
  }

  function stopBroadcast() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }

    mediaRecorderRef.current = null;
    setBroadcasting(false);

    if (socketRef.current) {
      socketRef.current.emit("broadcaster:stop");
    }
  }

  function joinAsViewer() {
    setError("");
    if (!streamKey) {
      setError("Enter a stream key to watch.");
      return;
    }

    const socket = ensureSocket();
    socket.emit("viewer:join", { streamKey });

    const video = viewerVideoRef.current;
    if (!video) {
      return;
    }

    const sourceUrl = `${HLS_BASE}/${streamKey}.m3u8`;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        liveSyncDurationCount: 3,
        maxBufferLength: 10
      });
      hlsRef.current = hls;
      hls.loadSource(sourceUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          setError("Stream not ready yet. Try again in a few seconds.");
          hls.destroy();
          hlsRef.current = null;
        }
      });
    } else {
      video.src = sourceUrl;
    }

    video.play().catch(() => null);
  }

  function stopViewer() {
    const video = viewerVideoRef.current;
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }

  function sendReaction(type) {
    if (!socketRef.current || !streamKey) {
      return;
    }
    socketRef.current.emit("viewer:reaction", { streamKey, type });
  }

  function resetStudio() {
    stopBroadcast();
    stopViewer();
    setLiveStatus(false);
    setPulses([]);
    setActivity([]);
    setError("");
  }

  return (
    <div className="page">
      <div className="aurora" />
      <header className="hero">
        <p className="badge">Docker-Native Live Platform</p>
        <h1>PulseCast Live Studio</h1>
        <p>
          Broadcast straight from your browser, transcode with FFmpeg in Docker, and track crowd energy with
          PulseMap moments in real time.
        </p>
      </header>

      <main className="grid">
        <section className="panel controls">
          <div className="toggle">
            <button
              className={mode === "broadcaster" ? "active" : ""}
              onClick={() => {
                resetStudio();
                setMode("broadcaster");
              }}
            >
              Broadcaster
            </button>
            <button
              className={mode === "viewer" ? "active" : ""}
              onClick={() => {
                resetStudio();
                setMode("viewer");
              }}
            >
              Viewer
            </button>
          </div>

          <label>Stream Key</label>
          <input
            value={streamKey}
            onChange={(event) => setStreamKey(event.target.value.toLowerCase())}
            placeholder="example: a1b2c3d4"
          />

          {generated && (
            <div className="meta">
              <p>Ingest: {generated.ingestUrl}/{generated.streamKey}</p>
              <p>Playback: {generated.playbackUrl}</p>
            </div>
          )}

          <div className="actions">
            <button onClick={createSession}>Create Stream Session</button>
            {mode === "broadcaster" ? (
              <>
                <button onClick={startCamera}>Preview Camera</button>
                {!broadcasting ? (
                  <button className="danger" onClick={startBroadcast}>
                    Go Live
                  </button>
                ) : (
                  <button className="danger" onClick={stopBroadcast}>
                    Stop Live
                  </button>
                )}
              </>
            ) : (
              <>
                <button onClick={joinAsViewer}>Join Stream</button>
                <button onClick={stopViewer}>Leave Stream</button>
              </>
            )}
          </div>

          <div className="status-row">
            <span className={liveStatus ? "dot live" : "dot"} />
            <strong>{liveStatus ? "Live" : "Offline"}</strong>
          </div>

          {error && <p className="error">{error}</p>}
        </section>

        <section className="panel media">
          <h2>{mode === "broadcaster" ? "Studio Monitor" : "Viewer Player"}</h2>
          {mode === "broadcaster" ? (
            <video ref={localVideoRef} muted playsInline autoPlay className="video" />
          ) : (
            <video ref={viewerVideoRef} controls playsInline className="video" />
          )}
        </section>

        <section className="panel pulse">
          <h2>PulseMap Timeline</h2>
          <p>Unique feature: reactions become a live engagement heat-map for moments and highlight discovery.</p>
          <PulseBars pulses={pulses} />

          <div className="reactions">
            {reactions.map((item) => (
              <button key={item.key} onClick={() => sendReaction(item.key)}>
                <span>{item.icon}</span> {item.label}
              </button>
            ))}
          </div>
        </section>

        <section className="panel feed">
          <h2>Live Activity</h2>
          <div className="feed-list">
            {activity.length ? (
              activity
                .slice()
                .reverse()
                .map((event, index) => (
                  <div className="feed-item" key={`${event.at}-${index}`}>
                    <strong>{event.type.toUpperCase()}</strong>
                    <span>{new Date(event.at).toLocaleTimeString()}</span>
                  </div>
                ))
            ) : (
              <div className="empty-block">No activity yet.</div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
