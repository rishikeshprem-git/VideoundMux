// Motion Audio backend — receives the silent video + audio track(s) from the
// plugin, muxes them with real ffmpeg (no browser API restrictions apply
// here), and returns one combined MP4.

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");

const app = express();

// Lock this down to your actual plugin origin before going further than
// local testing — "*" is fine for getting this running, not for production.
app.use(cors({ origin: "*" }));

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 50 * 1024 * 1024 } });

app.get("/", (req, res) => res.send("Motion Audio backend is running."));

// Quick diagnostic — hit this directly in a browser to confirm the bundled
// ffmpeg binary is actually present and runnable before testing a full mux.
// Also reports whether libx264 is compiled in, since some minimal
// ffmpeg-static builds omit it — that would explain a "successful" mux
// that's silently missing its video or audio stream.
app.get("/health", (req, res) => {
  execFile(ffmpegPath, ["-version"], (err, stdout) => {
    if (err) return res.status(500).json({ ffmpegPath, ok: false, error: err.message });
    execFile(ffmpegPath, ["-hide_banner", "-encoders"], (err2, encStdout) => {
      const hasLibx264 = !err2 && /libx264/.test(encStdout);
      res.json({ ffmpegPath, ok: true, version: stdout.split("\n")[0], hasLibx264 });
    });
  });
});

// Decomposes an arbitrary tempo factor into a chain of ffmpeg `atempo`
// filters, each kept within 0.5–2.0 — the range every ffmpeg build reliably
// supports per single atempo instance. This is what lets the UI's full
// 0.05x–3x speed range work regardless of the exact ffmpeg version running
// on the host, rather than depending on a single atempo call accepting the
// whole range directly.
function buildAtempoChain(speed) {
  const stages = [];
  let remaining = speed;
  if (remaining > 2.0) {
    while (remaining > 2.0) { stages.push(2.0); remaining /= 2.0; }
    stages.push(remaining);
  } else if (remaining < 0.5) {
    while (remaining < 0.5) { stages.push(0.5); remaining /= 0.5; }
    stages.push(remaining);
  } else {
    stages.push(remaining);
  }
  return stages.map((s) => `atempo=${s.toFixed(4)}`).join(",");
}

app.post("/mux", upload.fields([{ name: "video", maxCount: 1 }, { name: "audio", maxCount: 10 }]), (req, res) => {
  if (!req.files || !req.files.video) {
    return res.status(400).json({ error: "Missing video file." });
  }

  const videoPath = req.files.video[0].path;
  const audioPaths = (req.files.audio || []).map((f) => f.path);
  const outPath = path.join(os.tmpdir(), `motion-audio-out-${Date.now()}.mp4`);

  let meta = [];
  try { meta = JSON.parse(req.body.meta || "[]"); } catch (e) { /* fall through with empty meta */ }

  const cleanup = () => {
    fs.unlink(videoPath, () => {});
    audioPaths.forEach((p) => fs.unlink(p, () => {}));
    fs.unlink(outPath, () => {});
  };

  const baseArgs = ["-y", "-i", videoPath];
  audioPaths.forEach((p) => baseArgs.push("-i", p));

  if (audioPaths.length > 0) {
    // Per-track trim (atrim), timeline position, volume, and fade in/out —
    // this is what was missing originally: the backend was mixing full
    // untrimmed files regardless of what was edited in the UI.
    //
    // Track position used to be done with the `adelay` filter. Confirmed
    // via direct reproduction that adelay corrupts the output MP4's audio
    // track timestamp/duration metadata in this exact graph (stream copy
    // video + filtered audio + amix) — every exported file had a valid
    // video track but a garbage audio duration. Verified fix: position
    // tracks by concatenating a matching-format silent lead-in
    // (anullsrc) instead of shifting PTS with adelay. Also normalizing
    // every track to a common sample rate/layout (aformat) before
    // mixing, since tracks can come from files with different original
    // formats and amix assumes matching formats across inputs.
    const chains = audioPaths.map((_, i) => {
      const m = meta[i] || {};
      const trimStart = typeof m.trimStart === "number" ? m.trimStart : 0;
      const trimEnd = typeof m.trimEnd === "number" ? m.trimEnd : trimStart + 9999;
      const sourceDur = Math.max(0.05, trimEnd - trimStart); // duration in the SOURCE audio's own time
      const offsetSec = Math.max(0, m.startOffset || 0);
      const vol = typeof m.volume === "number" ? m.volume : 1;
      const speed = typeof m.speed === "number" && m.speed > 0 ? m.speed : 1;
      // atempo changes playback duration inversely to speed — this is the
      // duration the clip actually occupies on the timeline afterward,
      // which is what fade timings need to be computed against.
      const outDur = sourceDur / speed;

      let trimmed = `[${i + 1}:a]atrim=start=${trimStart}:duration=${sourceDur},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo`;
      if (speed !== 1) trimmed += `,${buildAtempoChain(speed)}`;
      trimmed += `,volume=${vol}`;
      if (m.fadeIn > 0) trimmed += `,afade=t=in:st=0:d=${m.fadeIn}`;
      if (m.fadeOut > 0 && outDur > m.fadeOut) trimmed += `,afade=t=out:st=${(outDur - m.fadeOut).toFixed(3)}:d=${m.fadeOut}`;

      if (offsetSec > 0) {
        trimmed += `[trimmed${i}];anullsrc=r=44100:cl=stereo:d=${offsetSec}[silence${i}];[silence${i}][trimmed${i}]concat=n=2:v=0:a=1[a${i}]`;
      } else {
        trimmed += `[a${i}]`;
      }
      return trimmed;
    });
    const mixInputs = audioPaths.map((_, i) => `[a${i}]`).join("");
    const filterComplex = chains.join(";") + `;${mixInputs}amix=inputs=${audioPaths.length}:duration=longest[aout]`;
    baseArgs.push("-filter_complex", filterComplex, "-map", "0:v", "-map", "[aout]");
  } else {
    baseArgs.push("-map", "0:v");
  }

  const bitrateKbps = parseInt(req.body.bitrateKbps, 10);
  const wantsReencode = Number.isFinite(bitrateKbps) && bitrateKbps > 0;

  function runFfmpeg(useReencode, onDone) {
    const videoCodecArgs = useReencode
      ? [
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-b:v", `${bitrateKbps}k`,
          "-maxrate", `${Math.round(bitrateKbps * 1.5)}k`,
          "-bufsize", `${bitrateKbps * 2}k`,
          "-pix_fmt", "yuv420p",
        ]
      : ["-c:v", "copy"];
    const args = [...baseArgs, "-shortest", ...videoCodecArgs, "-c:a", "aac", outPath];
    execFile(ffmpegPath, args, { timeout: 120_000 }, onDone);
  }

  function isGoodOutput(err, stderr) {
    if (err) return false;
    // ffmpeg can exit 0 while still having silently dropped a stream it
    // couldn't encode (seen with some minimal ffmpeg-static builds lacking
    // full libx264/audio-encoder support) — that produced a "successful"
    // response with a video-only file and no visible error anywhere.
    // Confirm the output actually contains an audio stream: ffmpeg always
    // logs "Stream #0:1... Audio:" in its own stderr for whatever it
    // actually wrote to the output file.
    if (audioPaths.length === 0) return true;
    const outputSection = (stderr || "").split(/Output #0/i)[1] || "";
    return /Audio:/i.test(outputSection);
  }

  // Try the requested quality re-encode first; if libx264 isn't actually
  // available on this host (or anything else about that path fails), fall
  // back automatically to plain stream copy — the exact combination that
  // was proven reliable before — rather than surfacing a broken export.
  // This trades away the quality-slider's precision on that one export,
  // but a working file matters more than exact bitrate control.
  runFfmpeg(wantsReencode, (err, stdout, stderr) => {
    if (wantsReencode && !isGoodOutput(err, stderr)) {
      console.error("Re-encode path failed or produced no audio, falling back to stream copy. ffmpeg log:", stderr);
      fs.unlink(outPath, () => {
        runFfmpeg(false, (err2, stdout2, stderr2) => {
          if (!isGoodOutput(err2, stderr2)) {
            cleanup();
            console.error("Fallback copy path also failed. ffmpeg log:", stderr2);
            return res.status(500).json({ error: "ffmpeg failed on both re-encode and fallback copy", details: (stderr2 || stderr)?.slice(-2000) });
          }
          res.sendFile(outPath, (sendErr) => { if (sendErr) console.error("Send failed:", sendErr); cleanup(); });
        });
      });
      return;
    }
    if (!isGoodOutput(err, stderr)) {
      cleanup();
      console.error("ffmpeg failed:", stderr);
      return res.status(500).json({ error: "ffmpeg failed", details: stderr?.slice(-2000) });
    }
    res.sendFile(outPath, (sendErr) => { if (sendErr) console.error("Send failed:", sendErr); cleanup(); });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Motion Audio backend listening on ${PORT}`));
