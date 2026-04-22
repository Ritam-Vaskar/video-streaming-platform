import { spawn } from "node:child_process";

export class StreamManager {
  constructor({ abrRtmpTarget, youtubeRtmpBase }) {
    this.abrRtmpTarget = abrRtmpTarget;
    this.youtubeRtmpBase = youtubeRtmpBase;
    this.processes = new Map();
  }

  startStream({ socketId, streamKey, youtubeKey, onExit }) {
    this.stopStream(socketId);

    const target720 = `${this.abrRtmpTarget}/${streamKey}_720p`;
    const target480 = `${this.abrRtmpTarget}/${streamKey}_480p`;
    const target240 = `${this.abrRtmpTarget}/${streamKey}_240p`;
    const targetRecord = "rtmp://rtmp:1935/live/" + streamKey;

    const normalizedYoutubeKey = String(youtubeKey || "").trim();
    const youtubeTarget = normalizedYoutubeKey ? `${this.youtubeRtmpBase}/${normalizedYoutubeKey}` : null;

    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-fflags",
      "+genpts+discardcorrupt+nobuffer",
      "-err_detect",
      "ignore_err",
      "-thread_queue_size",
      "8192",
      "-f",
      "webm",
      "-i",
      "pipe:0",
      "-filter_complex",
      [
        "[0:v]split=4[vrec][v720][v480][v240]",
        "[v720]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[v720out]",
        "[v480]scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2[v480out]",
        "[v240]scale=426:240:force_original_aspect_ratio=decrease,pad=426:240:(ow-iw)/2:(oh-ih)/2[v240out]"
      ].join(";"),

      "-map",
      "[vrec]",
      "-map",
      "0:a:0?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-profile:v",
      "main",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "60",
      "-keyint_min",
      "60",
      "-sc_threshold",
      "0",
      "-b:v",
      "2500k",
      "-maxrate",
      "2675k",
      "-bufsize",
      "3750k",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-b:a",
      "128k",
      "-f",
      "flv",
      targetRecord,

      "-map",
      "[v720out]",
      "-map",
      "0:a:0?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-profile:v",
      "main",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "60",
      "-keyint_min",
      "60",
      "-sc_threshold",
      "0",
      "-b:v",
      "2500k",
      "-maxrate",
      "2675k",
      "-bufsize",
      "3750k",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-b:a",
      "128k",
      "-f",
      "flv",
      target720,

      "-map",
      "[v480out]",
      "-map",
      "0:a:0?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-profile:v",
      "main",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "60",
      "-keyint_min",
      "60",
      "-sc_threshold",
      "0",
      "-b:v",
      "1000k",
      "-maxrate",
      "1070k",
      "-bufsize",
      "1500k",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-b:a",
      "128k",
      "-f",
      "flv",
      target480,

      "-map",
      "[v240out]",
      "-map",
      "0:a:0?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-profile:v",
      "main",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "60",
      "-keyint_min",
      "60",
      "-sc_threshold",
      "0",
      "-b:v",
      "500k",
      "-maxrate",
      "535k",
      "-bufsize",
      "750k",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-b:a",
      "96k",
      "-f",
      "flv",
      target240
    ];

    const ffmpeg = spawn("ffmpeg", args, {
      stdio: ["pipe", "ignore", "pipe"]
    });

    let youtubeFfmpeg = null;
    let youtubeRetryTimer = null;
    const processEntry = {
      ffmpeg,
      youtubeFfmpeg,
      youtubeRetryTimer,
      youtubeRelayStopped: false,
      streamKey
    };

    if (youtubeTarget) {
      // Keep YouTube forwarding independent so YouTube errors never take the primary stream offline.
      const youtubeArgs = [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-re",
        "-i",
        `rtmp://rtmp:1935/live/${streamKey}`,
        "-c",
        "copy",
        "-f",
        "flv",
        youtubeTarget
      ];

      const launchYoutubeRelay = () => {
        const liveEntry = this.processes.get(socketId);
        if (!liveEntry || liveEntry.youtubeRelayStopped) {
          return;
        }

        youtubeFfmpeg = spawn("ffmpeg", youtubeArgs, {
          stdio: ["ignore", "ignore", "pipe"]
        });

        liveEntry.youtubeFfmpeg = youtubeFfmpeg;

        youtubeFfmpeg.stderr.on("data", (chunk) => {
          const message = chunk.toString().trim();
          if (message) {
            console.log(`[ffmpeg-youtube:${streamKey}] ${message}`);
          }
        });

        youtubeFfmpeg.on("close", (code) => {
          if (liveEntry.youtubeRelayStopped) {
            return;
          }

          console.log(`[ffmpeg-youtube:${streamKey}] relay exited with code ${code ?? 0}, retrying`);
          liveEntry.youtubeRetryTimer = setTimeout(launchYoutubeRelay, 4000);
        });
      };

      processEntry.youtubeRetryTimer = setTimeout(launchYoutubeRelay, 2500);
    }

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

    this.processes.set(socketId, processEntry);
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

    const { ffmpeg, youtubeFfmpeg, youtubeRetryTimer } = entry;
    entry.youtubeRelayStopped = true;
    this.processes.delete(socketId);

    if (youtubeRetryTimer) {
      clearTimeout(youtubeRetryTimer);
    }

    if (ffmpeg.stdin.writable) {
      ffmpeg.stdin.end();
    }

    ffmpeg.kill("SIGINT");
    if (youtubeFfmpeg) {
      youtubeFfmpeg.kill("SIGINT");
    }

    setTimeout(() => {
      if (!ffmpeg.killed) {
        ffmpeg.kill("SIGKILL");
      }
      if (youtubeFfmpeg && !youtubeFfmpeg.killed) {
        youtubeFfmpeg.kill("SIGKILL");
      }
    }, 2000);
  }

  streamKeyFor(socketId) {
    return this.processes.get(socketId)?.streamKey;
  }
}
