# PulseCast Live (Dockerized Video Streaming Platform)

A custom live-streaming platform aligned with your architecture:

- Browser broadcaster publishes camera/mic over WebSocket
- Node backend ingests chunks and pipes to FFmpeg
- FFmpeg pushes RTMP to Nginx-RTMP ingest
- Nginx-RTMP packages HLS for playback
- Viewer clients watch via HLS and send reactions
- Unique feature: **PulseMap Timeline** (real-time audience engagement heat-map)

## Architecture

1. **Broadcaster Layer**
1. Browser captures camera/mic via `MediaRecorder`
2. Chunks sent to backend with Socket.IO

2. **Ingest Layer**
1. Backend accepts stream session + stream key
2. Backend starts FFmpeg process and forwards stream to RTMP

3. **Processing Layer**
1. FFmpeg transcodes browser media to H.264/AAC FLV
2. Nginx-RTMP converts live RTMP to HLS segments/playlists

4. **Delivery Layer**
1. Frontend uses `hls.js` for web playback
2. Viewers send reactions that update PulseMap in real time

## Services (Docker)

- `frontend`: React + Vite app served by Nginx (`http://localhost:3000`)
- `backend`: Node + Express + Socket.IO + FFmpeg (`http://localhost:5000`)
- `rtmp`: Nginx-RTMP ingest + HLS output
  - RTMP ingest: `rtmp://localhost:1935/live/<streamKey>`
  - HLS output: `http://localhost:8080/hls/<streamKey>.m3u8`

## Quick Start

1. Install Docker Desktop and ensure it is running.
2. From project root, run:

```bash
docker compose up --build
```

3. Open frontend: `http://localhost:3000`

## How To Use

1. In **Broadcaster** mode:
1. Click `Create Stream Session`
2. Click `Preview Camera`
3. Click `Go Live`

2. In **Viewer** mode (same or another browser/tab):
1. Paste same stream key
2. Click `Join Stream`
3. Use reaction buttons to feed PulseMap

## Custom Feature: PulseMap Timeline

PulseMap is a custom UX layer that turns audience reactions into a time-bucketed intensity graph.

- Reactions are grouped every 5 seconds
- Each reaction type has weighted impact
- Broadcaster and viewers can identify "hype moments" during live events

This can later drive:

- auto highlight clipping
- recap generation
- sponsorship moment analytics

## Environment Variables

See `.env.example`:

- `PORT` backend port
- `RTMP_SERVER` backend FFmpeg output target
- `CORS_ORIGIN` backend allowed frontend origin
- `VITE_API_URL` frontend API base URL
- `VITE_HLS_URL` frontend HLS base URL
- `VITE_SOCKET_URL` frontend socket endpoint

## Notes

- This prototype is optimized for fast iteration and local demo.
- Browser-to-FFmpeg ingest via `MediaRecorder` works best on Chromium-based browsers.
- For production hardening, add auth, persisted metadata, TLS, autoscaling, multi-bitrate ladder, and object storage origin.
