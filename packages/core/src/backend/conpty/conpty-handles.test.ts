// Handles a ConPTY leaves in the core after it ended (issue #177). The PTYs run `cmd.exe` and need no WSL, so the
// test runs on the Windows CI runner too.
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { conoutReader, spawnConpty } from "./spawn.js";

/** 40 PTYs leave 80 handles with the fix and 120 without; the limit of 100 keeps 20 on either side for noise. */
const PTYS = 40;
/**
 * Handles one PTY may leave after its natural end. node-pty 1.1.0 frees the HPCON only in its own `kill`, which no
 * longer reaches it once the process ended (ADR 0008): 2 handles per PTY stay. Before #177 the input pipe stayed
 * open as well, 3 per PTY.
 */
const MAX_HANDLES_PER_PTY = 2.5;

/** The kernel handle count of this process, as the Task Manager shows it; the median of three readings. */
async function handleCount(): Promise<number> {
  const readings = [await readHandleCount(), await readHandleCount(), await readHandleCount()];
  return readings.sort((a, b) => a - b)[1]!;
}

function readHandleCount(): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${process.pid}).HandleCount`],
      { windowsHide: true, timeout: 30_000 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(Number(stdout.trim()));
      },
    );
  });
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Starts `cmd /c echo x` and resolves once it reported its end; answers the DA1 query like a terminal. */
async function runToEnd(): Promise<void> {
  const pty = await spawnConpty("cmd.exe", ["/c", "echo x"], { cols: 80, rows: 24 }, process.cwd());
  let answered = false;
  pty.onData((data) => {
    if (!answered && data.includes("\x1b[c")) {
      answered = true;
      pty.write("\x1b[?1;2c");
    }
  });
  await new Promise<void>((resolve) => pty.onExit(() => resolve()));
}

describe.runIf(process.platform === "win32")("handles of ended ConPTYs (issue #177)", () => {
  it(`stay below ${MAX_HANDLES_PER_PTY} per PTY after ${PTYS} PTYs ended by themselves`, async () => {
    // Warm-up: node-pty, the worker of the reader and the DLLs of the bundled ConPTY are loaded once.
    await runToEnd();
    const reader = await conoutReader();
    await waitFor(() => (reader?.activeConnections ?? 0) === 0, "the reader to close the warm-up pipe");
    const before = await handleCount();

    // One after the other: several ConPTYs ending at the same moment crash node-pty 1.1.0 now and then (#160).
    for (let i = 0; i < PTYS; i++) await runToEnd();
    await waitFor(() => (reader?.activeConnections ?? 0) === 0, "the reader to close every pipe");
    // Sockets are closed asynchronously after their `close` call.
    await sleep(500);
    const grown = (await handleCount()) - before;

    expect(grown).toBeLessThan(PTYS * MAX_HANDLES_PER_PTY);
  }, 120_000);
});
