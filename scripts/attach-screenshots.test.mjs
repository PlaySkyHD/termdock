// Tests for the argument checks of scripts/attach-screenshots.sh. Run with `npm run test:hooks`.
// Only cases that fail before the script touches git or GitHub are tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./attach-screenshots.sh", import.meta.url));

function run(...args) {
  return spawnSync("bash", [script, ...args], { encoding: "utf8" });
}

function withFiles(names, body) {
  const dir = mkdtempSync(join(tmpdir(), "attach-test-"));
  try {
    const paths = names.map((name) => {
      const path = join(dir, name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "png");
      return path;
    });
    body(paths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("refuses two files with the same basename", () => {
  withFiles(["before/39-row.png", "after/39-row.png"], (paths) => {
    const result = run("pr", "1", ...paths);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /duplicate file name: 39-row\.png/);
  });
});

test("refuses a file name with other characters", () => {
  withFiles(["a b.png"], (paths) => {
    const result = run("pr", "1", ...paths);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /use only/);
  });
});

test("refuses a missing file", () => {
  const result = run("pr", "1", join(tmpdir(), "does-not-exist-attach.png"));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not a file/);
});

test("refuses a wrong kind", () => {
  const result = run("commit", "1", "x.png");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage/);
});
