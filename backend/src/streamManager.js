import { spawn } from "node:child_process";

export class StreamManager {
  constructor({ rtmpServer }) {
    this.rtmpServer = rtmpServer;
    this.processes = new Map();
  }

  startStream({ socketId, streamKey, onExit }) {
    this.stopStream(socketId);

    const target = `${this.rtmpServer}/${streamKey}`;
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-fflags",
      "nobuffer",
      "-f",
      "webm",
      "-i",
      "pipe:0",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "60",
      "-keyint_min",
      "60",
      "-sc_threshold",
      "0",
      "-c:a",
      "aac",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-b:a",
      "128k",
      "-f",
      "flv",
      target
    ];

    const ffmpeg = spawn("ffmpeg", args, {
      stdio: ["pipe", "ignore", "pipe"]
    });

    ffmpeg.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        console.log(`[ffmpeg:${streamKey}] ${message}`);
      }
    });

    ffmpeg.on("close", (code) => {
      this.processes.delete(socketId);
      if (onExit) {
        onExit(code ?? 0);
      }
    });

    this.processes.set(socketId, { ffmpeg, streamKey });
  }

  writeChunk(socketId, chunk) {
    const entry = this.processes.get(socketId);
    if (!entry || !entry.ffmpeg.stdin.writable) {
      return;
    }

    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    entry.ffmpeg.stdin.write(buffer);
  }

  stopStream(socketId) {
    const entry = this.processes.get(socketId);
    if (!entry) {
      return;
    }

    const { ffmpeg } = entry;
    this.processes.delete(socketId);

    if (ffmpeg.stdin.writable) {
      ffmpeg.stdin.end();
    }

    ffmpeg.kill("SIGINT");
    setTimeout(() => {
      if (!ffmpeg.killed) {
        ffmpeg.kill("SIGKILL");
      }
    }, 2000);
  }

  streamKeyFor(socketId) {
    return this.processes.get(socketId)?.streamKey;
  }
}
