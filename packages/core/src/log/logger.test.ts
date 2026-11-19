import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLogger,
  formatLine,
  MAX_LINE_BYTES,
  MAX_PENDING_LINES,
  rotatedPath,
  truncateText,
} from "./logger.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "termdock-log-"));
  dirs.push(dir);
  return dir;
}

const fixedNow = () => new Date("2026-11-19T10:00:00.000Z");

describe("formatLine", () => {
  it("writes time, level, source and text; later lines of the text are indented", () => {
    expect(formatLine(fixedNow(), "warn", "core", "a\nb")).toBe("2026-11-19T10:00:00.000Z warn core a\n  b");
  });
});

describe("rotatedPath", () => {
  it("numbers the rotated files before the extension", () => {
    expect(rotatedPath(path.join("d", "core.log"), 0)).toBe(path.join("d", "core.log"));
    expect(rotatedPath(path.join("d", "core.log"), 1)).toBe(path.join("d", "core.1.log"));
  });
});

describe("truncateText", () => {
  it("leaves a short text and cuts a long one with a marker", () => {
    expect(truncateText("short")).toBe("short");
    const cut = truncateText("x".repeat(MAX_LINE_BYTES + 100));
    expect(cut).toBe(`${"x".repeat(MAX_LINE_BYTES)} … [truncated 100 bytes]`);
  });

  it("does not split a multi-byte character", () => {
    const cut = truncateText("€".repeat(MAX_LINE_BYTES));
    expect(cut).not.toContain("�");
    expect(cut).toMatch(/ … \[truncated \d+ bytes\]$/);
  });

  it("cuts after the redaction: a secret across the limit leaves no part behind", async () => {
    const file = path.join(tempDir(), "core.log");
    const log = createLogger({ file, now: fixedNow, env: {} });
    // The token starts 20 bytes before the limit, so a cut before the redaction would keep "ghp_xxxxxxxxxxxxxxxx".
    log.error(`${".".repeat(MAX_LINE_BYTES - 20)}ghp_${"x".repeat(36)} ${"z".repeat(100)}`);
    await log.flush();
    const text = readFileSync(file, "utf8");
    expect(text).toContain("«redacted»");
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("xxxx");
  });

  it("applies to a logged line", async () => {
    const file = path.join(tempDir(), "core.log");
    const log = createLogger({ file, now: fixedNow, env: {} });
    log.error("y".repeat(MAX_LINE_BYTES * 2));
    await log.flush();
    const text = readFileSync(file, "utf8");
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_LINE_BYTES + 200);
    expect(text).toContain("[truncated 16384 bytes]");
  });
});

describe("createLogger", () => {
  it("creates the folder and writes redacted lines", async () => {
    const file = path.join(tempDir(), "logs", "core.log");
    const log = createLogger({ file, source: "core", now: fixedNow, env: {} });
    log.info("started");
    log.withSource("registry").error(`failed with ghp_${"x".repeat(36)}`);
    await log.flush();
    expect(readFileSync(file, "utf8")).toBe(
      "2026-11-19T10:00:00.000Z info core started\n" +
        "2026-11-19T10:00:00.000Z error registry failed with «redacted»\n",
    );
  });

  it("rotates at the limit and keeps at most two files", async () => {
    const dir = tempDir();
    const file = path.join(dir, "core.log");
    const log = createLogger({ file, maxBytes: 250, files: 2, now: fixedNow, env: {} });
    // "<iso> info app " is 34 bytes long; 65 more and the newline make 100 bytes per line.
    for (const mark of ["a", "b", "c", "d", "e"]) log.info(mark.padEnd(65, "."));
    await log.flush();
    expect(readdirSync(dir).sort()).toEqual(["core.1.log", "core.log"]);
    const active = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const older = readFileSync(path.join(dir, "core.1.log"), "utf8").split("\n").filter(Boolean);
    expect(active).toHaveLength(1);
    expect(older).toHaveLength(2);
    expect(active[0]).toContain(" e");
    expect(older[1]).toContain(" d");
    expect(Buffer.byteLength(readFileSync(file, "utf8"))).toBeLessThanOrEqual(250);
  });

  it("starts from the size of an existing file", async () => {
    const dir = tempDir();
    const file = path.join(dir, "core.log");
    writeFileSync(file, "y".repeat(240));
    const log = createLogger({ file, maxBytes: 250, now: fixedNow, env: {} });
    log.info("new");
    await log.flush();
    expect(readFileSync(path.join(dir, "core.1.log"), "utf8")).toBe("y".repeat(240));
    expect(readFileSync(file, "utf8")).toContain("info app new");
  });

  it("keeps more files when asked and drops the oldest", async () => {
    const dir = tempDir();
    const log = createLogger({
      file: path.join(dir, "core.log"),
      maxBytes: 40,
      files: 3,
      now: fixedNow,
      env: {},
    });
    for (let i = 0; i < 6; i += 1) log.info(`line ${i}`);
    await log.flush();
    expect(readdirSync(dir).sort()).toEqual(["core.1.log", "core.2.log", "core.log"]);
  });

  it("does not throw when writing fails, reports it once, and recovers", async () => {
    const dir = tempDir();
    // `logs` is a file: the folder cannot be created.
    const blocked = path.join(dir, "logs");
    writeFileSync(blocked, "not a folder");
    const errors: unknown[] = [];
    const mirrored: string[] = [];
    const log = createLogger({
      file: path.join(blocked, "core.log"),
      onWriteError: (error) => errors.push(error),
      mirror: (_line, _level, _source, text) => mirrored.push(text),
      env: {},
    });
    expect(() => log.error("lost")).not.toThrow();
    await log.flush();
    expect(errors).toHaveLength(1);
    expect(mirrored).toEqual(["lost"]);
    rmSync(blocked);
    mkdirSync(blocked);
    log.error("kept");
    await log.flush();
    expect(readFileSync(path.join(blocked, "core.log"), "utf8")).toContain("error app kept");
  });

  it("keeps writing to the active file when the rotation fails", async () => {
    const dir = tempDir();
    // A folder in the place of core.1.log: removing it as a file fails, like a locked file.
    mkdirSync(path.join(dir, "core.1.log"));
    const errors: unknown[] = [];
    const file = path.join(dir, "core.log");
    const log = createLogger({
      file,
      maxBytes: 200,
      onWriteError: (error) => errors.push(error),
      now: fixedNow,
      env: {},
    });
    log.info("a".repeat(80));
    log.info("b".repeat(80));
    await log.flush();
    expect(errors.length).toBeGreaterThan(0);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("b".repeat(80));
    expect(text).toContain("a".repeat(80));
  });

  it("drops lines beyond the queue limit and says how many", async () => {
    const dir = tempDir();
    const file = path.join(dir, "core.log");
    const log = createLogger({ file, maxBytes: 10 * 1024 * 1024, now: fixedNow, env: {} });
    for (let i = 0; i < MAX_PENDING_LINES + 25; i += 1) log.info(`line ${i}`);
    await log.flush();
    const text = readFileSync(file, "utf8");
    expect(text).toContain("warn log 25 lines dropped");
    expect(text).toContain(`line ${MAX_PENDING_LINES - 1}`);
    expect(text).not.toContain(`line ${MAX_PENDING_LINES}\n`);
  });

  it("survives a mirror and an error handler that throw", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "logs"), "x");
    const log = createLogger({
      file: path.join(dir, "logs", "core.log"),
      mirror: () => {
        throw new Error("mirror");
      },
      onWriteError: () => {
        throw new Error("handler");
      },
      env: {},
    });
    log.info("a");
    log.info("b");
    await expect(log.flush()).resolves.toBeUndefined();
  });

  it("writes only to the mirror without a file", async () => {
    const mirrored: string[] = [];
    const log = createLogger({ mirror: (line) => mirrored.push(line), now: fixedNow, env: {} });
    log.warn("w");
    await log.flush();
    expect(mirrored).toEqual(["2026-11-19T10:00:00.000Z warn app w"]);
  });
});
