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

const app = express();

// Lock this down to your actual plugin origin before going further than
// local testing — "*" is fine for getting this running, not for production.
app.use(cors({ origin: "*" }));

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 50 * 1024 * 1024 } });

app.get("/", (req, res) => res.send("Motion Audio backend is running."));

app.post("/mux", upload.fields([{ name: "video", maxCount: 1 }, { name: "audio", maxCount: 10 }]), (req, res) => {
  if (!req.files || !req.files.video) {
    return res.status(400).json({ error: "Missing video file." });
  }

  const videoPath = req.files.video[0].path;
  const audioPaths = (req.files.audio || []).map((f) => f.path);
  const outPath = path.join(os.tmpdir(), `motion-audio-out-${Date.now()}.mp4`);

  const cleanup = () => {
    fs.unlink(videoPath, () => {});
    audioPaths.forEach((p) => fs.unlink(p, () => {}));
    fs.unlink(outPath, () => {});
  };

  const args = ["-y", "-i", videoPath];
  audioPaths.forEach((p) => args.push("-i", p));

  if (audioPaths.length > 0) {
    const inputs = audioPaths.map((_, i) => `[${i + 1}:a]`).join("");
    args.push(
      "-filter_complex", `${inputs}amix=inputs=${audioPaths.length}:duration=longest[aout]`,
      "-map", "0:v", "-map", "[aout]"
    );
  } else {
    args.push("-map", "0:v");
  }

  args.push("-shortest", "-c:v", "copy", "-c:a", "aac", outPath);

  execFile("ffmpeg", args, { timeout: 60_000 }, (err, stdout, stderr) => {
    if (err) {
      cleanup();
      console.error("ffmpeg failed:", stderr);
      return res.status(500).json({ error: "ffmpeg failed", details: stderr?.slice(-2000) });
    }
    res.sendFile(outPath, (sendErr) => {
      if (sendErr) console.error("Send failed:", sendErr);
      cleanup();
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Motion Audio backend listening on ${PORT}`));
