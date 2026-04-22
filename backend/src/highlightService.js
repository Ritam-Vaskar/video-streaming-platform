import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const recordingsDir = process.env.RECORDINGS_DIR || "/app/media/recordings";
const highlightsDir = process.env.HIGHLIGHTS_DIR || "/app/media/highlights";
const publicHighlightsBase = process.env.HIGHLIGHTS_PUBLIC_BASE || "http://localhost:5000/media/highlights";

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `ffmpeg exited with ${code}`));
      }
    });
  });
}

export async function findLatestRecordingForStream(streamKey) {
  await fs.mkdir(recordingsDir, { recursive: true });
  const entries = await fs.readdir(recordingsDir, { withFileTypes: true });

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${streamKey}`) && entry.name.endsWith(".flv"))
    .map((entry) => entry.name)
    .sort();

  if (!files.length) {
    return null;
  }

  return path.join(recordingsDir, files[files.length - 1]);
}

export function pickHighlightBuckets(pulseBucketsMap, maxCount = 3) {
  const weighted = Array.from(pulseBucketsMap.entries()).map(([bucket, counts]) => {
    const weight = counts.fire * 4 + counts.wow * 3 + counts.heart * 2 + counts.clap;
    return { bucket, weight };
  });

  return weighted
    .filter((entry) => entry.weight >= 6)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, maxCount)
    .sort((a, b) => a.bucket - b.bucket);
}

export async function generateHighlights({ streamKey, streamStartedAt, pulseBucketsMap }) {
  const peaks = pickHighlightBuckets(pulseBucketsMap);
  if (!peaks.length) {
    return [];
  }

  const recording = await findLatestRecordingForStream(streamKey);
  if (!recording) {
    return [];
  }

  await fs.mkdir(highlightsDir, { recursive: true });

  const highlights = [];
  for (let index = 0; index < peaks.length; index += 1) {
    const peak = peaks[index];
    const peakOffsetSec = Math.max(0, Math.floor((peak.bucket - streamStartedAt) / 1000));
    const clipStart = Math.max(0, peakOffsetSec - 8);
    const clipDuration = 16;
    const fileName = `${streamKey}-highlight-${index + 1}.mp4`;
    const outputPath = path.join(highlightsDir, fileName);

    await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(clipStart),
      "-i",
      recording,
      "-t",
      String(clipDuration),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      outputPath
    ]);

    highlights.push({
      peakBucket: peak.bucket,
      score: peak.weight,
      clipUrl: `${publicHighlightsBase}/${fileName}`
    });
  }

  return highlights;
}
