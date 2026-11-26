// Security tests of the desktop main process (issue #135): a real core with FakeBackend behind the bridge.
// - A value from the environment of a profile reaches neither bridge answers nor `desktop.log`/`core.log`.
// - Escape sequences in terminal output reach the window unchanged; the main process acts on none of them.
// - The app has no code path that writes the clipboard, opens a link or sets a title from terminal output.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, FakeBackend, runCore } from "@termdock/core";
import type { CoreClient, RunCoreResult } from "@termdock/core";
import type { LaunchSpec } from "@termdock/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { BridgeEvent, BridgeResult } from "../shared/bridge.js";
import { DesktopBridge } from "./bridge.js";
import { createDesktopLogger } from "./diagnostics.js";

const SECRET = "td-test-secret-0000";
const SRC = fileURLToPath(new URL("../", import.meta.url));
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function uniquePipe(): string {
  const name = `termdock-test-${randomUUID()}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(tmpdir(), `${name}.sock`);
}

/** Core and bridge on their own pipe and data folder, one window that records its events. */
async function setup() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "termdock-desktop-security-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const pipePath = uniquePipe();
  const backend = new FakeBackend();
  const core: RunCoreResult = await runCore({
    pipePath,
    dataDir,
    backends: [backend],
    installSignalHandlers: false,
    stderr: { write: () => {} },
  });
  cleanups.push(() => core.close?.());
  const client: CoreClient = await connect(pipePath, { clientKind: "desktop", requestTimeoutMs: 5000 });
  cleanups.push(() => client.close());
  const bridge = new DesktopBridge(client);
  cleanups.push(() => bridge.dispose());
  const events: BridgeEvent[] = [];
  bridge.addWindow({ id: 1, send: (event) => void events.push(event) });
  const stderr: string[] = [];
  const logger = createDesktopLogger(dataDir, { write: (text) => void stderr.push(text) });
  /** Like main.ts: every failed call is logged with its message. */
  const call = async (raw: unknown): Promise<BridgeResult> => {
    const result = await bridge.call(1, raw);
    if (!result.ok) logger.error(`${(raw as { method: string }).method}: ${result.error.message}`);
    return result;
  };
  return { dataDir, backend, core, client, events, logger, stderr, call };
}

describe("secrets through the bridge (issue #135)", () => {
  it("stay out of bridge answers, desktop.log and core.log", async () => {
    const { dataDir, backend, core, logger, stderr, call } = await setup();
    const launch: LaunchSpec = {
      backend: "wsl",
      cwd: "/td-test/missing",
      command: ["td-test-tool"],
      env: { TD_TEST_VALUE: SECRET },
    };
    backend.missingCwds.add(launch.cwd);
    const created = await call({ method: "createProfile", profile: { name: "p", launch } });
    expect(created.ok).toBe(true);
    const profileId = (created as { value: { id: string } }).value.id;

    const answers: BridgeResult[] = [];
    // Invalid directory (a warning), backend error, bad_request of the guards and of a secret name.
    answers.push(await call({ method: "createSession", params: { name: "cwd", launch } }));
    backend.failNextStart = new Error("tmux new-session failed (exit 1): server exited unexpectedly");
    answers.push(await call({ method: "createSession", params: { name: "fail", launch } }));
    const broken = { ...launch, env: { TD_TEST_VALUE: SECRET, TD_TEST_NUMBER: 5 } };
    answers.push(await call({ method: "createSession", params: { name: "bad", launch: broken } }));
    const secretNamed = { ...launch, env: { TD_TEST_TOKEN: SECRET } };
    answers.push(await call({ method: "createProfile", profile: { name: "t", launch: secretNamed } }));
    answers.push(await call({ method: "updateProfile", profileId, change: { launch: secretNamed } }));
    answers.push(await call({ method: "createSession", params: { name: "t", launch: secretNamed } }));
    // Shape errors of the bridge itself.
    answers.push(await call({ method: "createProfile", profile: { name: "x", launch, env: SECRET } }));

    expect(answers.map((answer) => (answer.ok ? "ok" : answer.error.code))).toEqual([
      "ok",
      "backend_unavailable",
      "bad_request",
      "bad_request",
      "bad_request",
      "bad_request",
      "bad_request",
    ]);
    const first = answers[0] as { ok: true; value: { warnings?: unknown } };
    expect(JSON.stringify(first.value.warnings)).not.toContain(SECRET);
    for (const answer of answers.slice(1)) expect(JSON.stringify(answer)).not.toContain(SECRET);

    await logger.flush();
    await core.close?.();
    const logs = path.join(dataDir, "logs");
    const desktopLog = readFileSync(path.join(logs, "desktop.log"), "utf8");
    // The failures are logged, so the check below reads real lines.
    expect(desktopLog).toContain("createSession: Session");
    expect(desktopLog).toContain("TD_TEST_TOKEN");
    for (const name of readdirSync(logs)) {
      expect(readFileSync(path.join(logs, name), "utf8"), name).not.toContain(SECRET);
    }
    expect(stderr.join("")).not.toContain(SECRET);
  });
});

/** OSC 52 (clipboard write and query), OSC 8 (link), OSC 0/2 (title). */
const HOSTILE_OUTPUT =
  `\x1b]52;c;${Buffer.from("td-test clipboard").toString("base64")}\x07\x1b]52;c;?\x07` +
  "\x1b]8;;https://example.invalid/td-test\x1b\\link\x1b]8;;\x1b\\\r\n" +
  "\x1b]0;td-test title\x07\x1b]2;td-test window\x1b\\td-test end\r\n";

describe("terminal output through the bridge (issue #135)", () => {
  it("reaches the window byte for byte as output, and nothing else happens", async () => {
    const { dataDir, backend, core, events, logger, call } = await setup();
    const created = await call({
      method: "createSession",
      params: { name: "osc", launch: { backend: "wsl", cwd: "/home/dev" } },
    });
    const sessionId = (created as { value: { id: string } }).value.id;
    const attached = await call({ method: "attach", sessionId, size: { cols: 80, rows: 24 } });
    expect(attached.ok).toBe(true);
    // The events of the attach itself (writer, Running) come after its answer.
    const settled = Date.now() + 5000;
    while (!events.some((event) => event.kind === "stateChanged" && event.state === "Running")) {
      if (Date.now() > settled) throw new Error("the session did not become Running");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const before = events.length;
    const bytes = new TextEncoder().encode(HOSTILE_OUTPUT);
    backend.pty(sessionId).emitData(bytes);
    const deadline = Date.now() + 5000;
    const output = () =>
      Buffer.concat(
        events.flatMap((event) =>
          event.kind === "output" && event.sessionId === sessionId ? [event.data] : [],
        ),
      );
    while (!output().toString("latin1").includes("td-test end")) {
      if (Date.now() > deadline) throw new Error("output did not reach the window");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(output()).toEqual(Buffer.from(bytes));
    // Only output events followed; no title, clipboard or other event came out of the sequences.
    expect(events.slice(before).filter((event) => event.kind !== "output")).toEqual([]);
    // Nothing was written back to the program (no answer to the OSC 52 query).
    expect(backend.pty(sessionId).writes).toEqual([]);
    await logger.flush();
    await core.close?.();
    // Terminal output never reaches a log; here nothing was logged at all, so the folder may be missing.
    const logs = path.join(dataDir, "logs");
    for (const name of existsSync(logs) ? readdirSync(logs) : []) {
      expect(readFileSync(path.join(logs, name), "utf8"), name).not.toContain("td-test");
    }
  });
});

/** All shipped sources of the app (main, preload, shared, renderer) with their text. */
function appSources(dir = SRC): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) for (const [file, text] of appSources(full)) files.set(file, text);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      files.set(path.relative(SRC, full).split(path.sep).join("/"), readFileSync(full, "utf8"));
    }
  }
  return files;
}

describe("no code path acts on escape sequences (issue #135)", () => {
  it("has no OSC handler, clipboard addon, link handler, title listener or openExternal", () => {
    const forbidden: [RegExp, string][] = [
      [/registerOscHandler/, "own OSC handler (OSC 52 would write the clipboard)"],
      [/addon-clipboard|ClipboardAddon/, "xterm clipboard addon (OSC 52)"],
      [/addon-web-links|WebLinksAddon|linkHandler|registerLinkProvider/, "link opener for terminal output"],
      [/onTitleChange/, "title taken from terminal output"],
      [/openExternal/, "opening URLs outside the app"],
      [/import\s*\{[^}]*\bclipboard\b[^}]*\}\s*from\s*"electron"/, "clipboard of the main process"],
    ];
    const hits: string[] = [];
    for (const [file, text] of appSources()) {
      for (const [pattern, what] of forbidden) if (pattern.test(text)) hits.push(`${file}: ${what}`);
    }
    expect(hits).toEqual([]);
    const pkg = JSON.parse(readFileSync(path.join(SRC, "..", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).filter((name) => name.startsWith("@xterm/"))).toEqual([
      "@xterm/addon-fit",
      "@xterm/xterm",
    ]);
  });

  it("gives the file access no shell string and no network path (issue #201)", () => {
    const sources = appSources();
    for (const file of ["main/file-service.ts", "main/file-paths.ts", "main/file-bridge.ts"]) {
      const text = sources.get(file) ?? "";
      expect(text, file).not.toBe("");
      expect(text, file).not.toMatch(/child_process|execFile|spawn|\bexec\(|shell\.openExternal/);
    }
    // The renderer never names the channel (it only has `window.termdock.files`); main registers it once.
    const users = [...sources]
      .filter(([, text]) => /FILES_CHANNEL|termdock:files/.test(text))
      .map(([file]) => file);
    expect(users.sort()).toEqual(["main/main.ts", "shared/files.ts"]);
    const main = sources.get("main/main.ts") ?? "";
    expect(main.match(/ipcMain\.handle\(FILES_CHANNEL/g)).toHaveLength(1);
  });

  it("denies new windows and navigation, so an OSC 8 link xterm offers cannot open a page", () => {
    const main = readFileSync(path.join(SRC, "main", "main.ts"), "utf8");
    expect(main).toContain(`contents.setWindowOpenHandler(() => ({ action: "deny" }));`);
    expect(main).toContain(`contents.on("will-navigate", (event) => event.preventDefault());`);
    expect(main).toContain("sandbox: true");
    expect(main).toContain("contextIsolation: true");
  });
});
