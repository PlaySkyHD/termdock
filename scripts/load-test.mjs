// Load test with many sessions (issue #134). Local only, not in CI: needs WSL with tmux and a built core
// (`npm run typecheck` builds packages/core/dist).
//
// Usage: node scripts/load-test.mjs [--sessions <n>] [--noisy <n>] [--lines <n>] [--settle-ms <ms>]
//                                   [--echo-samples <n>] [--json <file>]
//
// It starts an isolated core (own pipe, temporary TERMDOCK_DATA_DIR, own tmux socket `termdock-test-<pid>-<nonce>`,
// so `cleanStaleWslTestServers` of any later WSL test run also removes what an aborted run left behind) with N WSL
// sessions (default 50). `--noisy` of them (default 10) print `--lines` lines of `yes` every 100 ms (default 200,
// about 4 KB/s each). It measures:
// - the time from the first `session.create` until every session runs (`Running`, or `Detached` without a view);
// - the time of the reconcile after a core restart (`hello` answered → first `session.list` answered; the core holds
//   every request but `hello` until the reconcile is done);
// - the working set (RSS) of the core after `--settle-ms` (default 60 s) with the noisy sessions running;
// - the latency input → echo in a quiet session while the noisy ones print (p50, p95, max).
// The result is printed as a table and as JSON (also to `--json <file>`). At the end it ends the core, the tmux
// server of its socket (with every session and the keepalive) and removes the data directory, also after a failure
// or Ctrl+C. It never touches the socket `termdock` or the user's core.
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextEncoder } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_DIST = join(ROOT, "packages", "core", "dist");
const ENTRY = join(CORE_DIST, "bin", "termdock-core.js");

/** Limits of issue #134, measured on the developer PC (design of change `viele-sessions`). */
export const LIMITS = Object.freeze({ reconcileMs: 3_000, rssMiB: 300, echoP95Ms: 100 });

/** States of a session whose process runs; without a view it is `Detached`. */
const RUNNING = new Set(["Running", "Detached"]);

export const DEFAULTS = Object.freeze({
  sessions: 50,
  noisy: 10,
  lines: 200,
  settleMs: 60_000,
  echoSamples: 40,
  json: undefined,
});

const OPTIONS = {
  "--sessions": "sessions",
  "--noisy": "noisy",
  "--lines": "lines",
  "--settle-ms": "settleMs",
  "--echo-samples": "echoSamples",
};

/** Parses the command line; throws on unknown options or values that are no positive integers (noisy ≥ 0). */
export function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--json") {
      if (value === undefined) throw new Error("--json needs a file");
      options.json = value;
      i++;
      continue;
    }
    const key = OPTIONS[arg];
    if (!key) throw new Error(`unknown option ${arg}`);
    if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${arg} needs a whole number`);
    options[key] = Number(value);
    i++;
  }
  if (options.sessions < 2) throw new Error("--sessions must be at least 2 (one quiet session for the echo)");
  if (options.noisy >= options.sessions) throw new Error("--noisy must leave at least one quiet session");
  if (options.lines < 1 || options.echoSamples < 1) throw new Error("--lines and --echo-samples must be > 0");
  return options;
}

/** The p-th percentile (0..100, nearest rank) of `values`; undefined for none. */
export function percentile(values, p) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/**
 * Each measured value against its limit; a missing value fails. The core shutdown passes only with exit code 0:
 * a crash (e.g. 3221225477 = 0xC0000005), a signal or a missing record fails.
 */
export function evaluate(result, limits = LIMITS) {
  const checks = [
    { name: "reconcile", value: result.reconcileMs, limit: limits.reconcileMs, unit: "ms" },
    { name: "rss", value: result.rssMiB, limit: limits.rssMiB, unit: "MiB" },
    { name: "echo p95", value: result.echo?.p95Ms, limit: limits.echoP95Ms, unit: "ms" },
  ].map((check) => ({
    ...check,
    ok: typeof check.value === "number" && check.value < check.limit,
  }));
  const shutdown = result.coreShutdown;
  checks.push({
    name: "core shutdown",
    value: shutdown?.code ?? undefined,
    limit: 0,
    unit: "",
    text: shutdown
      ? `exit ${shutdown.code ?? "-"}${shutdown.signal ? `, signal ${shutdown.signal}` : ""}` +
        (typeof shutdown.ms === "number" ? ` (${shutdown.ms} ms)` : "")
      : "-",
    rule: "exit 0",
    ok: shutdown?.code === 0,
  });
  return checks;
}

/** Table of the result for the console. */
export function formatTable(result, checks) {
  const rows = [
    ["sessions", `${result.sessions} (${result.noisy} noisy)`, ""],
    ["start until all run", `${result.startMs} ms`, ""],
    ["core restart until ready", `${result.restartReadyMs} ms`, ""],
    ...checks.map((check) => [
      check.name,
      check.text ?? (check.value === undefined ? "-" : `${check.value} ${check.unit}`),
      check.rule
        ? `${check.rule} ${check.ok ? "ok" : "FAILED"}`
        : `< ${check.limit} ${check.unit} ${check.ok ? "ok" : "OVER"}`,
    ]),
    ["echo p50 / max", `${result.echo?.p50Ms ?? "-"} / ${result.echo?.maxMs ?? "-"} ms`, ""],
  ];
  const width = [0, 1, 2].map((col) => Math.max(...rows.map((row) => row[col].length)));
  return rows
    .map((row) =>
      row
        .map((cell, col) => cell.padEnd(width[col]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** A socket of the run scheme of the WSL tests (`packages/core/src/test/wsl-socket.ts`); never `termdock`. */
export function loadTestSocket(pid = process.pid) {
  return `termdock-test-${pid}-${randomBytes(4).toString("hex")}`;
}

/** Run sockets as in `killWslTestServer`; any other name (above all `termdock`, `termdock-test`) is refused. */
const RUN_SOCKET = /^termdock-test-\d+-[0-9a-f]+$/;

/**
 * `wsl.exe` arguments that end the tmux server of `socket`. Throws for a socket that is not a run socket, so the
 * cleanup can never end the user's server.
 */
export function killServerArgs(socket, distro) {
  if (typeof socket !== "string" || !RUN_SOCKET.test(socket)) {
    throw new Error(`refusing kill-server on a socket that is not a run socket: ${JSON.stringify(socket)}`);
  }
  return [...(distro ? ["-d", distro] : []), "--cd", "~", "--exec", "tmux", "-L", socket, "kill-server"];
}

/** Argument array of the noisy program: `lines` lines of `yes` every 100 ms; no shell string with user input. */
export function noisyCommand(lines) {
  if (!Number.isInteger(lines) || lines < 1) throw new Error("lines must be a positive integer");
  return ["sh", "-c", `while :; do yes | head -n ${lines}; sleep 0.1; done`];
}

function runWsl(args, timeoutMs = 30_000) {
  return new Promise((done) => {
    execFile(
      "wsl.exe",
      args,
      { env: { ...process.env, WSL_UTF8: "1" }, timeout: timeoutMs, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) =>
        done({ code: error ? (typeof error.code === "number" ? error.code : null) : 0, stdout, stderr }),
    );
  });
}

/** Working set of a Windows process in MiB. */
function workingSetMiB(pid) {
  return new Promise((done, fail) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${Number(pid)}).WorkingSet64`],
      { windowsHide: true, encoding: "utf8", timeout: 30_000 },
      (error, stdout) => {
        const bytes = Number(stdout.trim());
        if (error || !Number.isFinite(bytes)) fail(error ?? new Error(`no working set for ${pid}`));
        else done(Math.round(bytes / 1024 / 1024));
      },
    );
  });
}

async function waitFor(predicate, what, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const last = await predicate();
    if (last === true) return;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
    await sleep(250);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(ENTRY)) throw new Error(`${ENTRY} missing: run npm run typecheck first`);
  const { connect } = await import(pathToFileURL(join(CORE_DIST, "ipc", "client.js")).href);
  const socket = loadTestSocket();
  // Checked before anything starts, so the cleanup below cannot fail on it.
  killServerArgs(socket);
  const pipePath = `\\\\.\\pipe\\termdock-load-${randomUUID()}`;
  const dataDir = mkdtempSync(join(tmpdir(), "termdock-load-"));
  const clients = [];
  let core;
  let distro;
  /** Exit code and signal of the core that `stopCore` ended; part of the result. */
  let coreShutdown;
  const log = (line) => process.stderr.write(`load-test: ${line}\n`);

  async function startCore() {
    const started = Date.now();
    core = spawn(process.execPath, [ENTRY], {
      env: {
        ...process.env,
        TERMDOCK_PIPE: pipePath,
        TERMDOCK_DATA_DIR: dataDir,
        TERMDOCK_TMUX_SOCKET: socket,
      },
      stdio: "ignore",
      windowsHide: true,
    });
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const client = await connect(pipePath, { clientKind: "load-test", requestTimeoutMs: 120_000 });
        clients.push(client);
        const hello = Date.now();
        await client.request("session.list", {});
        return { client, readyMs: Date.now() - started, reconcileMs: Date.now() - hello };
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await sleep(100);
      }
    }
  }

  async function stopCore() {
    const current = core;
    if (!current) return;
    // A core that died before the shutdown (crash under load) keeps its exit code and signal.
    if (current.exitCode !== null || current.signalCode !== null) {
      coreShutdown = { code: current.exitCode, signal: current.signalCode };
      return;
    }
    const exited = new Promise((done) => current.once("exit", (code, signal) => done({ code, signal })));
    // From the request until the process ended: with its PTYs closed one after the other (#160).
    const started = Date.now();
    try {
      await clients.at(-1)?.request("core.shutdown", { stopSessions: false });
    } catch {
      // The core may close the connection before it answers.
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      current.kill();
    }, 30_000);
    const { code, signal } = await exited;
    clearTimeout(timer);
    // A core that had to be killed did not shut down: no code, so the check fails.
    coreShutdown = timedOut
      ? { code: null, signal: signal ?? "timeout" }
      : { code, signal, ms: Date.now() - started };
    for (const client of clients.splice(0)) await client.close();
  }

  let cleaning;
  const cleanup = () =>
    (cleaning ??= (async () => {
      for (const client of clients.splice(0)) await client.close().catch(() => {});
      if (core && core.exitCode === null && core.signalCode === null) {
        const exited = new Promise((done) => core.once("exit", done));
        core.kill();
        await exited;
      }
      // The socket is ours alone: its server ends with every session; the keepalive waiting on it ends as well.
      const target = distro ? ["-d", distro] : [];
      await runWsl(killServerArgs(socket, distro));
      const left = await runWsl([...target, "--cd", "~", "--exec", "tmux", "-L", socket, "list-sessions"]);
      if (left.code === 0) log(`WARNING: sessions left on ${socket}: ${left.stdout.trim()}`);
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    })());
  process.once("SIGINT", () => void cleanup().then(() => process.exit(130)));

  try {
    log(`socket ${socket}, data ${dataDir}`);
    let { client } = await startCore();
    const ids = [];
    const quiet = [];
    const started = Date.now();
    // One after another: WSL is not hit with many parallel starts.
    for (let i = 0; i < options.sessions; i++) {
      const noisy = i < options.noisy;
      const launch = noisy
        ? { backend: "wsl", cwd: "/tmp", command: noisyCommand(options.lines) }
        : { backend: "wsl", cwd: "/tmp", command: ["sh"] };
      const { session } = (
        await client.request("session.create", {
          name: `${noisy ? "noisy" : "quiet"}-${i}`,
          launch,
          loggingEnabled: false,
        })
      ).result;
      distro ??= session.launch.distro;
      ids.push(session.id);
      if (!noisy) quiet.push(session.id);
    }
    const running = async () => {
      const { sessions } = (await client.request("session.list", {})).result;
      const states = sessions.map((session) => session.state);
      return states.length === ids.length && states.every((state) => RUNNING.has(state)) ? true : states;
    };
    await waitFor(running, "all sessions running", 120_000);
    const startMs = Date.now() - started;
    log(`${ids.length} sessions running after ${startMs} ms; waiting ${options.settleMs} ms`);

    await sleep(options.settleMs);
    const rssMiB = await workingSetMiB(core.pid);
    log(`core RSS ${rssMiB} MiB`);

    const echo = await measureEcho(client, quiet.at(-1), options.echoSamples);
    log(`echo p95 ${echo.p95Ms} ms`);

    await stopCore();
    const restarted = await startCore();
    client = restarted.client;
    const { sessions } = (await client.request("session.list", {})).result;
    const detached = sessions.filter((session) => session.state === "Detached").length;
    if (detached !== ids.length)
      throw new Error(`after the restart only ${detached}/${ids.length} sessions are Detached`);
    log(`reconcile ${restarted.reconcileMs} ms, ${detached} sessions Detached`);

    const result = {
      sessions: ids.length,
      noisy: options.noisy,
      linesPer100Ms: options.lines,
      startMs,
      restartReadyMs: restarted.readyMs,
      reconcileMs: restarted.reconcileMs,
      rssMiB,
      settleMs: options.settleMs,
      echo,
      coreShutdown,
    };
    const checks = evaluate(result);
    const report = { result, limits: LIMITS, checks };
    process.stdout.write(`${formatTable(result, checks)}\n\n${JSON.stringify(report, null, 2)}\n`);
    if (options.json) writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
  } finally {
    await cleanup();
    log("cleaned up");
  }
}

/** Sends one character at a time to a quiet `sh` and measures until its echo arrives. */
async function measureEcho(client, sessionId, samples) {
  const attached = await client.request("session.attach", { sessionId, size: { cols: 200, rows: 50 } });
  const { viewId } = attached.result;
  if (attached.result.writerViewId !== viewId) await client.request("session.claimWriter", { viewId });
  let waiting;
  // Only output that holds the typed `x` counts as its echo.
  const subscription = client.on("session.output", (data, payload) => {
    if (data.sessionId === sessionId && waiting && payload.includes(0x78)) waiting();
  });
  const latencies = [];
  try {
    // The repaint after the attach (issue #34) must not count as an echo.
    await sleep(1_000);
    for (let i = 0; i < samples; i++) {
      const echoed = new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error("no echo within 5 s")), 5_000);
        waiting = () => {
          clearTimeout(timer);
          done();
        };
      });
      const sent = performance.now();
      await client.request("session.input", { viewId }, new TextEncoder().encode("x"));
      await echoed;
      latencies.push(performance.now() - sent);
      waiting = undefined;
      await sleep(50);
    }
    // Ctrl+U clears the typed line.
    await client.request("session.input", { viewId }, Uint8Array.of(0x15));
  } finally {
    subscription.dispose();
    await client.request("session.detach", { viewId }).catch(() => {});
  }
  const round = (value) => Math.round(value * 10) / 10;
  return {
    samples: latencies.length,
    p50Ms: round(percentile(latencies, 50)),
    p95Ms: round(percentile(latencies, 95)),
    maxMs: round(Math.max(...latencies)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`load-test: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
