# Motion Audio backend

A tiny server with one job: take the silent video + audio file(s) the plugin
already produces, mux them with real `ffmpeg`, and hand back one MP4. No
browser API restrictions apply here — this is what actually solves the
audio-in-export problem, since two different in-browser approaches have now
both been blocked by Figma's plugin sandbox.

## Deploy it (Render.com — free tier, simplest option)

1. Push this folder to a GitHub repo (just this folder, or your whole project
   with this as a subfolder).
2. Go to https://render.com → New → Web Service → connect the repo.
3. Render will detect the `Dockerfile` automatically. If asked:
   - **Environment**: Docker
   - **Region**: closest to you
   - **Instance type**: Free is fine to start
4. Deploy. You'll get a URL like `https://motion-audio-backend.onrender.com`.
5. Visit that URL in a browser — you should see "Motion Audio backend is
   running." That confirms it's live.

Free tier note: Render's free instances sleep after inactivity and take ~30s
to wake on the next request — fine for testing, worth upgrading once this is
in front of real users.

## Test it directly (optional, before wiring up the plugin)

```bash
curl -X POST https://YOUR-APP.onrender.com/mux \
  -F "video=@test-video.mp4" \
  -F "audio=@test-audio.mp3" \
  --output combined.mp4
```

If `combined.mp4` plays with sound, the backend works — any remaining issue
is in the plugin's upload code, not here.

## Connect the plugin
1. Copy your deployed URL.
2. In the plugin's `manifest.json`, add your domain to `allowedDomains`
   (e.g. `"https://motion-audio-backend.onrender.com"`).
3. In `ui.html`, set `BACKEND_MUX_URL` to `https://YOUR-APP.onrender.com/mux`.
4. Re-import the plugin in Figma and export — it'll now upload to this
   backend instead of relying on in-browser encoding.

## Before showing this to anyone else
- Lock down `cors({ origin: "*" })` in `server.js` to your actual plugin's
  origin.
- Add basic rate limiting / file size limits (a small `limits` object is
  already set on the upload, worth tightening further).
- Consider auth (even a simple shared secret header) so the endpoint isn't
  open to the whole internet.
