// Failure scenario "the core is ended hard" (issue #133): the core runs as its own process (`dist/test/flooding-core.js`,
// built by `npm run typecheck`, as in the CI) with a session that prints without pause and a client that saves the
// layout over and over. The test ends the process like the Task Manager (TerminateProcess, no shutdown) while both
// are writing, then checks what is on disk. No WSL needed.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { LAYOUT_VERSION, MIN_HISTORY_LIMIT_BYTES } from "@termdock/protocol";
import type { LayoutDocument } from "@termdock/protocol";
import { FakeBackend } from "../backend/fake.js";
import { connect } from "../ipc/client.js";
import type { CoreClient } from "../ipc/client.js";
import { DATABASE_FILE, openStorage } from "../storage/database.js";
import { historySegmentPath, readHistory } from "../storage/history-store.js";
import { runCore } from "./run-core.js";

const ENTRY = fileURLToPath(new URL("../../dist/test/flooding-core.js", import.meta.url));
const decoder = new TextDecoder();
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A layout whose window id names the save it belongs to, so a stored layout shows which save wrote it. */
function layoutOf(save: number): LayoutDocument {
  return {
    version: LAYOUT_VERSION,
    windows: [
      {
        id: `window-${save}`,
        tabs: [{ id: "t1", root: { kind: "pane", id: "p1", sessionId: "gone" }, activePaneId: "p1" }],
        activeTabId: "t1",
      },
    ],
  };
}

function historyBytes(dataDir: string, sessionId: string): number {
  let total = 0;
  for (const index of [0, 1] as const) {
    const path = historySegmentPath(dataDir, sessionId, index);
    if (existsSync(path)) total += statSync(path).size;
  }
  return total;
}

async function until(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

describe("hard kill of the core while it writes (issue #133)", () => {
  it("[V1-11] leaves a readable database, a readable history within the limit and no half-saved layout", async () => {
    expect(existsSync(ENTRY), `${ENTRY} missing: run npm run typecheck first`).toBe(true);
    const dataDir = mkdtempSync(join(tmpdir(), "termdock-hard-kill-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const pipePath = `\\\\.\\pipe\\termdock-hard-kill-${randomUUID()}`;
    const core: ChildProcess = spawn(process.execPath, [ENTRY], {
      env: { ...process.env, TERMDOCK_PIPE: pipePath, TERMDOCK_DATA_DIR: dataDir },
      stdio: "ignore",
      windowsHide: true,
    });
    const exited = new Promise<void>((resolve) => core.once("exit", () => resolve()));
    cleanups.push(async () => {
      if (core.exitCode === null && core.signalCode === null) core.kill();
      await exited;
    });

    let c: CoreClient | undefined;
    const deadline = Date.now() + 20_000;
    while (!c) {
      try {
        c = await connect(pipePath, { requestTimeoutMs: 10_000 });
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await sleep(100);
      }
    }
    const client = c;
    cleanups.push(() => client.close());
    await client.request("settings.set", { settings: { historyLimitBytes: MIN_HISTORY_LIMIT_BYTES } });
    const { session } = (
      await client.request("session.create", { name: "flood", launch: { backend: "wsl", cwd: "/tmp" } })
    ).result;

    // Saves one after another, each on the revision before; the loop ends when the core is gone.
    let acknowledged = 0;
    let saving = true;
    const saves = (async () => {
      while (saving) {
        try {
          const { revision } = (
            await client.request("layout.save", {
              layout: layoutOf(acknowledged + 1),
              baseRevision: acknowledged,
            })
          ).result;
          acknowledged = revision;
        } catch {
          return;
        }
      }
    })();

    // At least one change of segments, and some layout revisions, before the kill.
    await until(
      () => historyBytes(dataDir, session.id) > MIN_HISTORY_LIMIT_BYTES / 2 && acknowledged >= 20,
      "history over one segment and 20 layout revisions",
    );
    core.kill();
    await exited;
    saving = false;
    await saves;
    const lastAcknowledged = acknowledged;

    // SQLite: the file is intact.
    const db = new DatabaseSync(join(dataDir, DATABASE_FILE));
    try {
      expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    } finally {
      db.close();
    }

    // Layout: the stored revision is the last acknowledged one or the save in flight, with that save's document.
    const storage = openStorage({ dataDir, onLayoutInvalid: (message) => expect.fail(message) });
    try {
      const stored = storage.layouts.get();
      expect([lastAcknowledged, lastAcknowledged + 1]).toContain(stored.revision);
      expect(stored.layout).toEqual(layoutOf(stored.revision));
      expect(storage.sessions.list().map((s) => s.id)).toEqual([session.id]);
    } finally {
      storage.dispose();
    }

    // History: within the limit, and every entry it delivers is whole lines of the flood in order.
    expect(historyBytes(dataDir, session.id)).toBeLessThanOrEqual(MIN_HISTORY_LIMIT_BYTES);
    let text = "";
    for await (const entry of readHistory(dataDir, session.id)) text += decoder.decode(entry.data);
    const lines = text.split("\r\n").filter((line) => line !== "");
    expect(lines.length).toBeGreaterThan(100);
    const numbers = lines.map((line) => {
      expect(line).toMatch(/^flood \d{8}$/);
      return Number(line.slice(6));
    });
    for (let i = 1; i < numbers.length; i++) expect(numbers[i]).toBe(numbers[i - 1]! + 1);

    // The next core starts on the same data: the session is Interrupted (its process died with the core) and the
    // layout is the stored one.
    const backend = new FakeBackend();
    const next = await runCore({
      pipePath,
      dataDir,
      backends: [backend],
      installSignalHandlers: false,
      stderr: { write: () => {} },
    });
    cleanups.push(() => next.close?.());
    expect(next.exitCode).toBe(0);
    expect(next.restore?.sessions).toEqual([{ sessionId: session.id, from: "Detached", to: "Interrupted" }]);
    const again = await connect(pipePath, { requestTimeoutMs: 10_000 });
    cleanups.push(() => again.close());
    const reloaded = (await again.request("layout.get", {})).result;
    expect(reloaded.layout).toEqual(layoutOf(reloaded.revision));
  }, 60_000);
});
