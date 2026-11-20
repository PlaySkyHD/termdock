// Tests for scripts/video-frames.cjs: step and file name calculation, argument checks. Decoding a real video needs
// Electron and is checked by hand (see the lessons file); no video of a user is stored in the repository.
// Run with `npm run test:hooks`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(new URL("./video-frames.cjs", import.meta.url));
const { frameTimes, frameName, parseStep, parseArgs, videoPage, MAX_FRAMES } = createRequire(import.meta.url)(
  script,
);

test("frame times step through the video and stay below its end", () => {
  assert.deepEqual(frameTimes(2.495, 0.5), [0, 0.5, 1, 1.5, 2]);
  assert.deepEqual(frameTimes(3, 1), [0, 1, 2, 2.95]);
  assert.deepEqual(frameTimes(10, 10), [0, 9.95]);
  assert.deepEqual(frameTimes(10, 20), [0]);
});

test("frame times have no float drift for small steps", () => {
  const times = frameTimes(1, 0.1);
  assert.equal(times.length, 11);
  assert.equal(times[3], 0.3);
  assert.equal(times[7], 0.7);
});

test("a video shorter than the end margin gives one frame", () => {
  assert.deepEqual(frameTimes(0.04, 0.01), [0]);
});

test("frame times refuse an unusable duration and too many frames", () => {
  assert.throws(() => frameTimes(Infinity, 1), /no usable duration/);
  assert.throws(() => frameTimes(0, 1), /no usable duration/);
  assert.throws(() => frameTimes(NaN, 1), /no usable duration/);
  assert.throws(() => frameTimes(MAX_FRAMES * 2, 1), /exceed the limit.*step of at least/);
  assert.equal(frameTimes(MAX_FRAMES - 1, 1).length, MAX_FRAMES);
});

test("frame names are f-<seconds>.png and sort by time", () => {
  assert.equal(frameName(0), "f-00000.000.png");
  assert.equal(frameName(12.5), "f-00012.500.png");
  assert.equal(frameName(1234.0005), "f-01234.001.png");
  const names = [100, 9.5, 20, 0.25].map(frameName);
  assert.deepEqual([...names].sort(), [0.25, 9.5, 20, 100].map(frameName));
});

test("the page escapes the file URL, so a name with an HTML entity loads that file", () => {
  const page = videoPage(join(tmpdir(), `a&amp;b"c'<d>.mp4`));
  const src = /src="([^"]*)"/.exec(page)[1];
  assert.match(src, /a&amp;amp;b/);
  assert.doesNotMatch(src, /[<>']/);
  // Undoing the escaping the way an HTML parser does gives back the real file URL.
  const decoded = src
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
  assert.equal(decoded, pathToFileURL(join(tmpdir(), `a&amp;b"c'<d>.mp4`)).href);
  assert.equal(page.match(/"/g).length, 4);
});

test("the step must be a positive number of seconds", () => {
  assert.equal(parseStep("0.5"), 0.5);
  for (const bad of ["0", "-1", "abc", "", " ", "NaN", "Infinity", "0.0001", undefined]) {
    assert.throws(() => parseStep(bad), /step must be a number/, String(bad));
  }
});

test("arguments name an existing video and a step", () => {
  const dir = mkdtempSync(join(tmpdir(), "video-frames-test-"));
  try {
    const video = join(dir, "v.mp4");
    writeFileSync(video, "not really a video");
    const args = parseArgs([video, join(dir, "out"), "2"]);
    assert.equal(args.step, 2);
    assert.equal(args.video, video);
    assert.throws(() => parseArgs([join(dir, "missing.mp4"), dir, "1"]), /video not found/);
    assert.throws(() => parseArgs([dir, dir, "1"]), /video not found/);
    assert.throws(() => parseArgs([video, dir]), /usage/);
    assert.throws(() => parseArgs([video, dir, "0"]), /step must be/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the command line exits with 2 on bad arguments, before any window opens", () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(
    process.execPath,
    [script, join(tmpdir(), "does-not-exist-frames.mp4"), tmpdir(), "1"],
    {
      encoding: "utf8",
      env,
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /video not found/);
});

test("the command line refuses to run with ELECTRON_RUN_AS_NODE", () => {
  const result = spawnSync(process.execPath, [script, "a", "b", "1"], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 30_000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /ELECTRON_RUN_AS_NODE/);
});
