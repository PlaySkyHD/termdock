// Reproduction of issue #160: ending many PTYs at once crashed node-pty 1.1.0 now and then (0xC0000005). Needs no
// WSL: the PTYs run `cmd.exe` in a ConPTY. Local only (Windows); needs the core build `packages/core/dist`
// (`npm run typecheck`).
//
// Usage: node scripts/pty-shutdown-repro.mjs [--runs <n>] [--ptys <n>] [--mode dispose|kill|raw] [--parallel <n>]
//
// Every run is its own child process (a crash ends only that one), started with the same runtime as this script, so
// `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/pty-shutdown-repro.mjs` tests Electron.
// Modes:
// - `dispose` (default): the core path of a core that ends without stopping its sessions. A `SessionRegistry` with a
//   backend whose PTYs come from the core's `spawnConpty` and `ConptyPty`, N sessions, then `registry.dispose()` and the
//   wait for the PTYs (`ptysClosed`), as `runCore` does it.
// - `kill`: the path of `core.shutdown { stopSessions }`: `registry.killAll` for all sessions; the backend ends each
//   shell itself (`exit`), as tmux `kill-session` ends its client. Before #160 all those ends came at once.
// - `raw`: node-pty alone, every PTY killed at once without waiting; crashes on main and with the fix alike.
// It prints one line per run and a summary; the exit code is 1 when a run did not end with code 0.
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_DIST = join(ROOT, "packages", "core", "dist");
const MODES = new Set(["dispose", "kill", "raw"]);
/** A child that has not ended after this counts as hung. */
const CHILD_TIMEOUT_MS = 120_000;

/** Parses the command line; throws on unknown options or values. */
export function parseArgs(argv) {
  const options = { runs: 50, ptys: 20, mode: "dispose", parallel: 1, child: false };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === "--child") {
      options.child = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${name} needs a value`);
    if (name === "--mode") {
      if (!MODES.has(value)) throw new Error(`--mode must be one of ${[...MODES].join(", ")}`);
      options.mode = value;
      continue;
    }
    const key = { "--runs": "runs", "--ptys": "ptys", "--parallel": "parallel" }[name];
    if (!key) throw new Error(`unknown option ${name}`);
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
    options[key] = number;
  }
  return options;
}

const load = (path) => import(pathToFileURL(join(CORE_DIST, ...path.split("/"))).href);
/** The first of `paths` that exists: builds before #65 kept the ConPTY code under `backend/wsl/`. */
async function loadFirst(...paths) {
  for (const path of paths) {
    try {
      return await load(path);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND" || path === paths.at(-1)) throw error;
    }
  }
  throw new Error("no path given");
}

/** A backend of `cmd.exe` PTYs through the core's ConPTY path; no persistence. */
function cmdBackend({ spawnConpty }, { ConptyPty, WslPty }) {
  const Pty = ConptyPty ?? WslPty;
  const live = new Map();
  return {
    kind: "wsl",
    available: async () => true,
    start: async (id, _spec, size) => {
      const pty = await spawnConpty("cmd.exe", [], size, ROOT);
      const ended = new Promise((done) => pty.onExit(() => done()));
      live.set(id, { pty, ended });
      ended.then(() => live.delete(id));
      return new Pty(pty, async () => ({}));
    },
    attach: async () => {
      throw new Error("no persistence");
    },
    exists: async (id) => live.has(id),
    // As tmux `kill-session`: the program ends by itself, the PTY sees a natural end.
    kill: async (id) => {
      const entry = live.get(id);
      if (!entry) return;
      try {
        entry.pty.write("exit\r");
      } catch {
        // Closed already (`killAll` closes the PTY first).
      }
      await Promise.race([entry.ended, sleep(10_000)]);
    },
    snapshot: async () => undefined,
  };
}

async function waitFor(predicate, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** One run in this process; prints a JSON line with the time the PTYs took to end. */
async function child({ mode, ptys }) {
  const hang = setTimeout(() => process.exit(2), CHILD_TIMEOUT_MS);
  hang.unref();
  if (mode === "raw") {
    const nodePty = await import("node-pty");
    const terminals = [];
    for (let i = 0; i < ptys; i++) {
      const terminal = nodePty.spawn("cmd.exe", [], { cols: 80, rows: 24, cwd: ROOT, useConptyDll: true });
      let seen = false;
      terminal.onData((data) => {
        seen = true;
        if (data.includes("\x1b[c")) terminal.write("\x1b[?1;2c");
      });
      terminals.push({ terminal, seen: () => seen });
    }
    await waitFor(() => terminals.every((t) => t.seen()), "output of every PTY");
    await sleep(300);
    const started = performance.now();
    for (const { terminal } of terminals) terminal.kill();
    process.stdout.write(`${JSON.stringify({ closeMs: Math.round(performance.now() - started) })}\n`);
    // The exits come shortly after the kills; that is where node-pty crashed.
    await sleep(1_000);
    process.exit(0);
  }
  const processes = await loadFirst("backend/conpty/spawn.js", "backend/wsl/processes.js");
  const pty = await loadFirst("backend/conpty/pty.js", "backend/wsl/pty.js");
  const { SessionRegistry } = await load("session/registry.js");
  const registry = new SessionRegistry({ backends: [cmdBackend(processes, pty)], onListenerError: () => {} });
  const seen = new Set();
  registry.onOutput((event) => seen.add(event.sessionId));
  const ids = [];
  for (let i = 0; i < ptys; i++) {
    const info = await registry.create({ name: `pty-${i}`, launch: { backend: "wsl", cwd: "/" } });
    ids.push(info.id);
  }
  await waitFor(() => ids.every((id) => seen.has(id)), "output of every session");
  await sleep(300);
  const started = performance.now();
  if (mode === "kill") {
    // As `core.shutdown { stopSessions }`; before #160 it called `kill` for all sessions at once.
    if (registry.killAll) await registry.killAll(ids);
    else await Promise.all(ids.map((id) => registry.kill(id)));
  }
  registry.dispose();
  // Before #160 the core did not wait for its PTYs; their exits came while it handed its keepalives over.
  if (processes.ptysClosed) await processes.ptysClosed();
  else await sleep(1_000);
  process.stdout.write(`${JSON.stringify({ closeMs: Math.round(performance.now() - started) })}\n`);
  // As the core: `runCore` ends the process right after its close (`termdock-core.ts`).
  process.exit(0);
}

/** Runs one child; resolves with its exit code, signal and reported close time. */
function runChild(options) {
  return new Promise((done) => {
    const args = [
      fileURLToPath(import.meta.url),
      "--child",
      "--mode",
      options.mode,
      "--ptys",
      `${options.ptys}`,
    ];
    const proc = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => (stdout += data));
    proc.stderr.on("data", (data) => (stderr += data));
    proc.on("exit", (code, signal) => {
      let closeMs;
      try {
        closeMs = JSON.parse(stdout.trim().split("\n").at(-1) ?? "").closeMs;
      } catch {
        closeMs = undefined;
      }
      done({ code, signal, closeMs, stderr: stderr.trim() });
    });
  });
}

/** `0xC0000005` instead of `3221225477` (or `-1073741819`). */
export const hex = (code) =>
  code !== null && (code < 0 || code > 0xffff) ? `0x${(code >>> 0).toString(16).toUpperCase()}` : `${code}`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.child) return child(options);
  if (process.platform !== "win32") throw new Error("needs Windows (ConPTY)");
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < options.runs) {
      const run = ++next;
      const result = await runChild(options);
      results.push(result);
      const detail =
        result.code === 0 ? `${result.closeMs ?? "-"} ms` : result.stderr.split("\n").at(-1) || "";
      process.stdout.write(`run ${run}: exit ${hex(result.code)} ${detail}\n`);
    }
  };
  await Promise.all(Array.from({ length: options.parallel }, worker));
  const failed = results.filter((result) => result.code !== 0);
  const times = results.map((result) => result.closeMs).filter((ms) => typeof ms === "number");
  times.sort((a, b) => a - b);
  const median = times.length > 0 ? times[Math.floor(times.length / 2)] : "-";
  process.stdout.write(
    `${options.mode}: ${results.length} runs with ${options.ptys} PTYs, ${failed.length} failed; ` +
      `close median ${median} ms, max ${times.at(-1) ?? "-"} ms (${process.versions.electron ? `Electron ${process.versions.electron}` : `Node ${process.version}`})\n`,
  );
  process.exitCode = failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
