# PulseCast Live (Dockerized Video Streaming Platform)

A custom live-streaming platform aligned with your architecture:

- Browser broadcaster publishes camera/mic over WebSocket
- Node backend ingests chunks and pipes to FFmpeg
- FFmpeg pushes RTMP to Nginx-RTMP ingest
- Nginx-RTMP packages HLS for playback
- Viewer clients watch via HLS and send reactions
- Unique feature: **PulseMap Timeline** (real-time audience engagement heat-map)
- Secure login + role-based broadcaster authorization
- Multi-bitrate ABR ladder (240p/480p/720p)
- Stream recording and auto-highlight generation from PulseMap peaks
- Optional YouTube Live simulcast using RTMP stream key

## Architecture

1. **Broadcaster Layer**
1. Browser captures camera/mic via `MediaRecorder`
2. Chunks sent to backend with Socket.IO

2. **Ingest Layer**
1. Backend accepts stream session + stream key
2. Backend enforces broadcaster role before starting live ingest

3. **Processing Layer**
1. FFmpeg transcodes browser media into ABR ladder outputs (720p/480p/240p)
2. Nginx-RTMP receives ladder outputs and publishes HLS master + variants
3. Nginx records source stream to `.flv` files for post-live clipping

4. **Delivery Layer**
1. Frontend uses `hls.js` for web playback
2. Viewers send reactions that update PulseMap in real time
3. Backend creates highlight clips from reaction peaks after stream stop

## Services (Docker)

- `frontend`: React + Vite app served by Nginx (`http://localhost:3000`)
- `backend`: Node + Express + Socket.IO + FFmpeg (`http://localhost:5000`)
- `rtmp`: Nginx-RTMP ingest + HLS output
  - RTMP ingest apps:
    - `live` (source ingest + recording)
    - `hls` (ABR renditions for HLS packaging)
  - HLS output: `http://localhost:8080/hls/<streamKey>.m3u8`

## Default Credentials

Use these in the frontend login form (change in env for production):

- Broadcaster: `broadcaster@pulsecast.local` / `Broadcaster@123`
- Viewer: `viewer@pulsecast.local` / `Viewer@123`

## Quick Start

1. Install Docker Desktop and ensure it is running.
2. From project root, run:

```bash
docker compose up --build
```

3. Open frontend: `http://localhost:3000`

## How To Use

1. In **Broadcaster** mode:
1. Login using broadcaster credentials
2. Optional: enter YouTube RTMP stream key
1. Click `Create Stream Session`
2. Click `Preview Camera`
3. Click `Go Live`

2. In **Viewer** mode (same or another browser/tab):
1. Paste same stream key
2. Click `Join Stream`
3. Use reaction buttons to feed PulseMap

3. After stopping stream:
1. Auto-highlight clips appear in the UI and can be opened directly

## Custom Feature: PulseMap Timeline

PulseMap is a custom UX layer that turns audience reactions into a time-bucketed intensity graph.

- Reactions are grouped every 5 seconds
- Each reaction type has weighted impact
- Broadcaster and viewers can identify "hype moments" during live events

This can later drive:

- auto highlight clipping
- recap generation
- sponsorship moment analytics

## YouTube Live Simulcast

1. Create a YouTube Live event and copy your stream key.
2. In Broadcaster panel, paste key into `YouTube RTMP Stream Key`.
3. Start live. Backend FFmpeg forwards 720p output to:

`rtmp://a.rtmp.youtube.com/live2/<your-stream-key>`

4. Ensure the YouTube event is configured for H.264 + AAC.

## Environment Variables

See `.env.example`:

- `PORT` backend port
- `RTMP_ABR_TARGET` backend FFmpeg ABR output target (rtmp hls app)
- `YOUTUBE_RTMP_BASE` YouTube ingest base URL
- `CORS_ORIGIN` backend allowed frontend origin
- `JWT_SECRET` JWT signing secret (set a strong secret in production)
- `USERS_FILE` path for persisted users JSON
- `RECORDINGS_DIR` path for recorded stream `.flv` files
- `HIGHLIGHTS_DIR` path for generated `.mp4` clips
- `HIGHLIGHTS_PUBLIC_BASE` public URL prefix for highlight files
- `DEFAULT_BROADCASTER_EMAIL`, `DEFAULT_BROADCASTER_PASSWORD`
- `DEFAULT_VIEWER_EMAIL`, `DEFAULT_VIEWER_PASSWORD`
- `VITE_API_URL` frontend API base URL
- `VITE_HLS_URL` frontend HLS base URL
- `VITE_SOCKET_URL` frontend socket endpoint

## Notes

- This project is now role-protected, supports ABR, recording, and auto-highlights.
- Browser-to-FFmpeg ingest via `MediaRecorder` works best on Chromium-based browsers.
- For production hardening, add TLS, horizontal scaling, key management service, and persistent DB.
