// Saves single frames of a video as PNG files, for videos that users send (screen recordings of a UI error).
// The host has no ffmpeg; this uses the Electron from node_modules, whose Chromium decodes mp4 (H.264) and webm.
//
//   unset ELECTRON_RUN_AS_NODE
//   node_modules/electron/dist/electron.exe scripts/video-frames.cjs <video> <output-folder> <seconds-between-frames>
//
// Writes `<output-folder>/f-<seconds>.png` (e.g. `f-00012.500.png`, sorted by time). Put the folder outside the
// repository (`P:/Temp/...`), look at the images with Read afterwards, and never commit a user's video or frames.
// Exit codes: 0 done, 1 failed while reading the video, 2 bad arguments.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

/** At most this many frames per run; a longer video needs a bigger step (keeps the folder and the run bounded). */
const MAX_FRAMES = 300;
/** Smallest allowed step; the frame names have millisecond resolution. */
const MIN_STEP_SECONDS = 0.001;
const SEEK_TIMEOUT_MS = 15_000;
const LOAD_TIMEOUT_MS = 30_000;

/** Parses the step argument; returns the number or throws a message for the user. */
function parseStep(text) {
  const step = Number(text);
  if (text === undefined || text.trim() === "" || !Number.isFinite(step) || step < MIN_STEP_SECONDS) {
    throw new Error(`step must be a number of seconds of at least ${MIN_STEP_SECONDS}, got: ${text}`);
  }
  return step;
}

/**
 * The times (in seconds) at which frames are taken: 0, step, 2*step, ... up to the end of the video, rounded to
 * milliseconds. The last frame is taken slightly before the end, because seeking to the exact end may show nothing.
 * Throws when the result would exceed `maxFrames`.
 */
function frameTimes(duration, step, maxFrames = MAX_FRAMES) {
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error(`the video has no usable duration: ${duration}`);
  const count = Math.floor(duration / step + 1e-9) + 1;
  if (count > maxFrames) {
    throw new Error(
      `${count} frames exceed the limit of ${maxFrames}; use a step of at least ${Math.ceil((duration / (maxFrames - 1)) * 1000) / 1000} seconds`,
    );
  }
  const end = Math.max(0, duration - 0.05);
  const times = [];
  for (let k = 0; k < count; k += 1) times.push(Math.round(Math.min(k * step, end) * 1000) / 1000);
  // A video shorter than the end margin gives the same time twice; keep each time once.
  return times.filter((time, index) => index === 0 || time !== times[index - 1]);
}

/** `f-<seconds>.png` with the seconds zero-padded to five digits and three decimals, so names sort by time. */
function frameName(seconds) {
  const [whole, fraction] = seconds.toFixed(3).split(".");
  return `f-${whole.padStart(5, "0")}.${fraction}.png`;
}

/** Validates the command line and returns `{ video, outDir, step }`; throws a message for the user. */
function parseArgs(argv) {
  if (argv.length !== 3)
    throw new Error("usage: video-frames.cjs <video> <output-folder> <seconds-between-frames>");
  const video = path.resolve(argv[0]);
  if (!fs.existsSync(video) || !fs.statSync(video).isFile()) throw new Error(`video not found: ${video}`);
  return { video, outDir: path.resolve(argv[1]), step: parseStep(argv[2]) };
}

/** Escapes text for a double-quoted HTML attribute; `pathToFileURL` leaves `&` (and `'`) as they are. */
function escapeAttribute(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** The page that shows the video file; the file URL is escaped, so a name like `a&amp;b.mp4` loads that file. */
function videoPage(video) {
  return `<!doctype html><video muted preload="auto" src="${escapeAttribute(pathToFileURL(video).href)}"></video>`;
}

/** Runs inside the page: waits for the metadata and returns the duration. */
const DURATION_SCRIPT = `new Promise((resolve, reject) => {
  const video = document.querySelector("video");
  if (!video) return reject(new Error("the file is not a video this Electron can play"));
  const done = () => resolve(video.duration);
  if (video.readyState >= 1) return done();
  video.addEventListener("loadedmetadata", done, { once: true });
  video.addEventListener("error", () => reject(new Error("the video cannot be decoded")), { once: true });
})`;

/** Runs inside the page: seeks to `time` and returns the frame as a PNG data URL. */
function frameScript(time) {
  return `new Promise((resolve, reject) => {
  const video = document.querySelector("video");
  const timer = setTimeout(() => reject(new Error("seek to ${time} timed out")), ${SEEK_TIMEOUT_MS});
  video.addEventListener("seeked", () => {
    clearTimeout(timer);
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    resolve(canvas.toDataURL("image/png"));
  }, { once: true });
  video.currentTime = ${time};
})`;
}

async function extract({ video, outDir, step }) {
  // Loaded only here so the helpers above work under plain Node (tests).
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  fs.mkdirSync(outDir, { recursive: true });
  // The page is the user's local video file shown by Chromium: no script of its own, no Node access. Web security
  // is off only so that the canvas may read frames of a `file:` video.
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, webSecurity: false },
  });
  const withTimeout = (promise, ms, what) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  try {
    const page = videoPage(video);
    await withTimeout(
      window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`),
      LOAD_TIMEOUT_MS,
      "loading the page",
    );
    const duration = await withTimeout(
      window.webContents.executeJavaScript(DURATION_SCRIPT),
      LOAD_TIMEOUT_MS,
      "reading the duration",
    );
    const times = frameTimes(duration, step);
    for (const time of times) {
      const url = await window.webContents.executeJavaScript(frameScript(time));
      const file = path.join(outDir, frameName(time));
      fs.writeFileSync(file, Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
      console.log(file);
    }
    console.log(`${times.length} frames of ${duration.toFixed(3)} s in ${outDir}`);
  } finally {
    window.destroy();
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  try {
    await extract(args);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

module.exports = { frameTimes, frameName, parseStep, parseArgs, videoPage, MAX_FRAMES };

// Electron starts the script as its app, where `require.main` is not the script; under plain Node (tests) it is.
if (require.main === module || process.versions.electron) {
  if (process.env.ELECTRON_RUN_AS_NODE) {
    console.error("ELECTRON_RUN_AS_NODE is set: run `unset ELECTRON_RUN_AS_NODE` first");
    process.exit(2);
  }
  main().then((code) => {
    // `app.exit` ends Electron without waiting for windows; under plain Node there is no `app`.
    const electron = require("electron");
    if (electron && electron.app) electron.app.exit(code);
    else process.exit(code);
  });
}
