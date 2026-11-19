import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopLogger,
  flushWithin,
  helpMenuTemplate,
  openLogFolder,
  OPEN_LOG_FOLDER_LABEL,
} from "./diagnostics.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createDesktopLogger", () => {
  it("writes redacted lines to logs/desktop.log and mirrors them on stderr", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "termdock-desktop-log-"));
    dirs.push(dir);
    const stderr: string[] = [];
    const log = createDesktopLogger(dir, { write: (text) => stderr.push(text) });
    log.error(`render-process-gone: crashed, token ghp_${"x".repeat(36)}`);
    await log.flush();
    const file = readFileSync(path.join(dir, "logs", "desktop.log"), "utf8");
    expect(file).toMatch(/Z error desktop render-process-gone: crashed, token «redacted»\n$/);
    expect(stderr).toEqual(["termdock-desktop: render-process-gone: crashed, token «redacted»\n"]);
  });

  it("still logs to stderr when the data directory is unknown", async () => {
    const stderr: string[] = [];
    const log = createDesktopLogger(undefined, { write: (text) => stderr.push(text) });
    log.warn("no folder");
    await log.flush();
    expect(stderr).toEqual(["termdock-desktop: no folder\n"]);
  });
});

describe("openLogFolder", () => {
  it("creates logs/ and opens it", async () => {
    const calls: string[] = [];
    await openLogFolder(path.join("data", "TermDock"), {
      makeDir: async (folder) => void calls.push(`mkdir ${folder}`),
      openPath: async (folder) => (calls.push(`open ${folder}`), ""),
      log: (text) => calls.push(`log ${text}`),
    });
    const folder = path.join("data", "TermDock", "logs");
    expect(calls).toEqual([`mkdir ${folder}`, `open ${folder}`]);
  });

  it("logs the message of shell.openPath and an exception, and never throws", async () => {
    const lines: string[] = [];
    await openLogFolder("d", {
      openPath: async () => "no application",
      makeDir: async () => {},
      log: (t) => lines.push(t),
    });
    await openLogFolder("d", {
      openPath: async () => "",
      makeDir: async () => {
        throw new Error("EACCES");
      },
      log: (t) => lines.push(t),
    });
    expect(lines).toEqual([
      `could not open the log folder ${path.join("d", "logs")}: no application`,
      `could not open the log folder ${path.join("d", "logs")}: EACCES`,
    ]);
  });
});

describe("flushWithin", () => {
  it("returns once the logger has written", async () => {
    let done = false;
    await flushWithin({ flush: async () => void (done = true) }, 1000);
    expect(done).toBe(true);
  });

  it("gives up after the time limit when the write hangs", async () => {
    const started = Date.now();
    await flushWithin({ flush: () => new Promise<void>(() => {}) }, 50);
    expect(Date.now() - started).toBeLessThan(900);
  });

  it("does not reject when the flush fails", async () => {
    await expect(flushWithin({ flush: () => Promise.reject(new Error("x")) }, 50)).resolves.toBeUndefined();
  });
});

describe("helpMenuTemplate", () => {
  it("has the menu Hilfe with the entry Log-Ordner öffnen that calls the handler", () => {
    const open = vi.fn();
    const menu = helpMenuTemplate(open);
    expect(menu.label).toBe("Hilfe");
    expect(menu.submenu.map((item) => item.label)).toEqual([OPEN_LOG_FOLDER_LABEL]);
    expect(OPEN_LOG_FOLDER_LABEL).toBe("Log-Ordner öffnen");
    menu.submenu[0]!.click();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
