// The shared ConPTY output reader (issue #153, ADR 0008). The PTY tests run `cmd.exe` through node-pty and need
// no WSL, so they run on the Windows CI runner too.
import { createRequire } from "node:module";
import { connect as connectPipe } from "node:net";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConoutReader,
  installConoutReader,
  nodePtyVersion,
  SUPPORTED_NODE_PTY_VERSION,
} from "./conout-reader.js";
import type { ConoutConnection } from "./conout-reader.js";
import { conoutReader, spawnConpty } from "./processes.js";
import type { ConptyProcess } from "./processes.js";

const MiB = 1024 * 1024;

/** What held when a PTY reported its end. */
interface ExitSeen {
  exitCode: unknown;
  processAlive: boolean;
  output: string;
}

interface Opened {
  pty: ConptyProcess;
  output: () => string;
  exits: () => number;
  exitSeen: ExitSeen[];
  exited: Promise<void>;
}

const opened: Opened[] = [];
const readers: ConoutReader[] = [];

/** `cmd.exe <args>` in a ConPTY; answers the DA1 query of the bundled ConPTY like a terminal would. */
async function openCmd(args: string[] = []): Promise<Opened> {
  const pty = await spawnConpty("cmd.exe", args, { cols: 120, rows: 30 }, process.cwd());
  let text = "";
  let answered = false;
  const exitSeen: ExitSeen[] = [];
  pty.onData((data) => {
    text += data;
    if (!answered && data.includes("\x1b[c")) {
      answered = true;
      pty.write("\x1b[?1;2c");
    }
  });
  const exited = new Promise<void>((resolve) =>
    pty.onExit(({ exitCode }) => {
      exitSeen.push({ exitCode, processAlive: alive(pty.pid), output: text });
      resolve();
    }),
  );
  const entry = { pty, output: () => text, exits: () => exitSeen.length, exitSeen, exited };
  opened.push(entry);
  return entry;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  // One after another, each awaited: several kills in a row crash node-pty 1.1.0 now and then (#160).
  for (const entry of opened.splice(0)) {
    if (entry.exits() === 0) {
      entry.pty.kill();
      await Promise.race([entry.exited, sleep(5_000)]);
    }
  }
  for (const reader of readers.splice(0)) await reader.dispose();
});

describe("node-pty version", () => {
  it("is the version whose ConoutConnection the reader replaces (update node-pty only together with ADR 0008)", () => {
    expect(nodePtyVersion()).toBe(SUPPORTED_NODE_PTY_VERSION);
  });

  it("logs one line and leaves node-pty unchanged for any other version", () => {
    const original = function OriginalConoutConnection() {};
    const internal = { ConoutConnection: original };
    const log = vi.fn();
    const load = (id: string) => (id.endsWith("package.json") ? { version: "1.2.0" } : internal);
    expect(installConoutReader(new ConoutReader(), { log, load })).toBe(false);
    expect(internal.ConoutConnection).toBe(original);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("node-pty 1.2.0 is not 1.1.0");
  });

  it("replaces ConoutConnection for 1.1.0, and a connection without running worker throws instead of blocking", () => {
    const original = function OriginalConoutConnection() {};
    const internal: { ConoutConnection: unknown } = { ConoutConnection: original };
    const load = (id: string) => (id.endsWith("package.json") ? { version: "1.1.0" } : internal);
    const reader = new ConoutReader();
    readers.push(reader);
    expect(installConoutReader(reader, { log: () => {}, load })).toBe(true);
    expect(internal.ConoutConnection).not.toBe(original);
    const Replaced = internal.ConoutConnection as new (pipe: string, useConptyDll: boolean) => unknown;
    expect(() => new Replaced("\\\\.\\pipe\\conpty-test-out", true)).toThrow("no worker running");
  });
});

describe("ConoutReader worker", () => {
  it("rejects ready() when the worker fails to start, and starts a new one on the next call", async () => {
    const log = vi.fn();
    const broken = new ConoutReader({ workerSource: "throw new Error('broken worker')", log });
    readers.push(broken);
    await expect(broken.ready()).rejects.toThrow("before it started");
    const reader = new ConoutReader();
    readers.push(reader);
    await reader.ready();
    expect(reader.workerThreadId).toBeTypeOf("number");
  });
});

describe.skipIf(process.platform !== "win32")("PTYs on the shared reader (cmd.exe, no WSL)", () => {
  it("20 PTYs share one worker thread and add far less than one worker each to the RSS", async () => {
    // Warm up: node-pty and the worker are loaded once per process, not per PTY.
    const first = await openCmd();
    await waitFor(() => first.output().length > 0, "output of the first PTY");
    const reader = await conoutReader();
    const thread = reader?.workerThreadId;
    await sleep(1_000);
    const before = process.memoryUsage().rss;
    const ptys: Opened[] = [];
    for (let i = 0; i < 20; i++) ptys.push(await openCmd());
    await waitFor(() => ptys.every((entry) => entry.output().length > 0), "output of all PTYs");
    await sleep(2_000);
    const grown = (process.memoryUsage().rss - before) / MiB;
    // One node-pty worker per PTY costs 8 to 12 MiB, 160 to 240 MiB for 20 (issue #153); measured here about 0.4 MiB
    // per PTY. 60 MiB leaves room for a busy runner.
    expect(grown).toBeLessThan(60);
    expect(reader).toBeDefined();
    expect(reader!.workerThreadId).toBe(thread);
    expect(reader!.activeConnections).toBe(21);
  }, 120_000);

  it("kill() does not block while every PTY prints, every PTY ends and the worker closes its pipes", async () => {
    const ptys: Opened[] = [];
    for (let i = 0; i < 5; i++) ptys.push(await openCmd());
    await waitFor(() => ptys.every((entry) => entry.output().includes(">")), "prompts");
    for (const { pty } of ptys) pty.write("for /L %i in (1,1,1000000) do @echo line %i\r");
    await waitFor(() => ptys.every((entry) => entry.output().includes("line 2000")), "full output");
    let slowest = 0;
    // One after another, each awaited: several kills in a row crash node-pty 1.1.0 now and then (#160).
    for (const { pty, exited } of ptys) {
      const started = performance.now();
      pty.kill();
      slowest = Math.max(slowest, performance.now() - started);
      await exited;
    }
    // Measured at most 1.3 ms; a ClosePseudoConsole waiting for the output to drain would take seconds or forever.
    expect(slowest).toBeLessThan(1_000);
    await Promise.all(ptys.map((entry) => entry.exited));
    const reader = await conoutReader();
    await waitFor(() => reader!.activeConnections === 0, "no pipe left in the worker");
    expect(ptys.map((entry) => entry.exits())).toEqual([1, 1, 1, 1, 1]);
  }, 120_000);

  it("delivers the last output before the end, with the program's exit code, and closes the pipe", async () => {
    const reader = (await conoutReader())!;
    await reader.ready();
    const before = reader.activeConnections;
    const entry = await openCmd(["/c", "echo marker-153"]);
    await entry.exited;
    expect(entry.exitSeen[0]!.output).toContain("marker-153");
    expect(entry.exitSeen[0]!.exitCode).toBe(0);
    expect(entry.exitSeen[0]!.processAlive).toBe(false);
    await waitFor(() => reader.activeConnections === before, "the worker closed the pipe");
  }, 60_000);

  it("closes the ConPTY only once when kill() is called twice", async () => {
    const agentModule = createRequire(import.meta.url)("node-pty/lib/windowsPtyAgent.js") as {
      WindowsPtyAgent: { prototype: { kill(): void } };
    };
    const spy = vi.spyOn(agentModule.WindowsPtyAgent.prototype, "kill");
    try {
      const entry = await openCmd();
      await waitFor(() => entry.output().includes(">"), "prompt");
      entry.pty.kill();
      entry.pty.kill();
      await entry.exited;
      await sleep(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(entry.exits()).toBe(1);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it("lets no other client connect to the relay pipe once node-pty is connected", async () => {
    const reader = (await conoutReader())!;
    await reader.ready();
    const connections: ConoutConnection[] = [];
    const connect = reader.connect.bind(reader);
    const spy = vi.spyOn(reader, "connect").mockImplementation((pipe: string) => {
      const connection = connect(pipe);
      connections.push(connection);
      return connection;
    });
    let entry: Opened;
    try {
      entry = await openCmd();
    } finally {
      spy.mockRestore();
    }
    // Output arrives only through node-pty's connection, accepted before the worker closed the server.
    await waitFor(() => entry.output().includes(">"), "prompt");
    expect(connections).toHaveLength(1);
    // The pipe name lives on with node-pty's instance, but no instance is free: a client gets ENOENT or waits until
    // it gives up (ERROR_PIPE_BUSY, then ETIMEDOUT after 30 s). With the server still listening it would connect at
    // once.
    const outcome = await new Promise<string>((resolve) => {
      const socket = connectPipe(`${connections[0]!.pipe}-worker`);
      const timer = setTimeout(() => {
        socket.destroy();
        resolve("no connection");
      }, 3_000);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.destroy();
        resolve("connected");
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolve("no connection");
      });
    });
    expect(outcome).toBe("no connection");
  }, 60_000);

  it("ends only the PTY whose relay connection fails, once and with an exit code, without crashing the core", async () => {
    // node-pty's terminal objects, caught in their constructor (`Terminal.prototype._forwardEvents`, node-pty 1.1.0).
    const base = createRequire(import.meta.url)("node-pty/lib/terminal.js") as {
      Terminal: { prototype: { _forwardEvents(this: unknown, ...args: unknown[]): unknown } };
    };
    const original = base.Terminal.prototype._forwardEvents;
    const terminals: unknown[] = [];
    base.Terminal.prototype._forwardEvents = function (this: unknown, ...args: unknown[]) {
      terminals.push(this);
      return original.apply(this, args);
    };
    let broken: Opened;
    let healthy: Opened;
    const reader = (await conoutReader())!;
    await reader.ready();
    // Pipes of earlier tests end up to 1 s after their kill (drain time).
    await waitFor(() => reader.activeConnections === 0, "no pipe of an earlier test in the worker", 5_000);
    try {
      broken = await openCmd();
      healthy = await openCmd();
    } finally {
      base.Terminal.prototype._forwardEvents = original;
    }
    await waitFor(() => broken.output().includes(">") && healthy.output().includes(">"), "prompts");
    const outSocket = (
      terminals[0] as {
        _agent: { _outSocket: { emit(event: string, error: Error): void; allowHalfOpen: boolean } };
      }
    )._agent._outSocket;

    // A client of the relay that keeps its side open after the end of the output, as a foreign client that took
    // `<pipe>-worker` first might (#177); the pipe must not stay in the worker.
    outSocket.allowHalfOpen = true;
    // What node-pty's connect to `<pipe>-worker` reports when another client took the pipe first.
    outSocket.emit("error", Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }));

    await broken.exited;
    expect(broken.exitSeen[0]!.processAlive).toBe(false);
    expect(broken.exitSeen[0]!.exitCode).toBeTypeOf("number");
    await sleep(500);
    expect(broken.exits()).toBe(1);
    // The relay of the broken PTY is closed in the worker as well, although its client holds its side open (#177).
    await waitFor(() => reader.activeConnections === 1, "only the healthy pipe in the worker", 5_000);
    healthy.pty.write("echo still-%NUMBER_OF_PROCESSORS%-here\r");
    await waitFor(() => /still-\d+-here/.test(healthy.output()), "output of the other PTY");
    expect(healthy.exits()).toBe(0);
  }, 60_000);

  it("leaves no pipe in the worker when a PTY cannot start", async () => {
    const reader = (await conoutReader())!;
    await reader.ready();
    const before = reader.activeConnections;
    await expect(
      spawnConpty("termdock-missing-153.exe", [], { cols: 80, rows: 24 }, process.cwd()),
    ).rejects.toThrow();
    expect(reader.activeConnections).toBe(before);
  }, 60_000);

  it("closes every PTY once when the worker crashes and starts a new worker for the next PTY", async () => {
    const ptys: Opened[] = [];
    for (let i = 0; i < 3; i++) ptys.push(await openCmd());
    await waitFor(() => ptys.every((entry) => entry.output().includes(">")), "prompts");
    // A PTY that already ended on its own is not reported again.
    const done = await openCmd();
    await waitFor(() => done.output().includes(">"), "prompt of the PTY that ends first");
    const reader = (await conoutReader())!;
    const before = reader.activeConnections;
    done.pty.write("exit\r");
    await done.exited;
    // The worker closes the pipe of a PTY that ended without `kill` by itself.
    await waitFor(
      () => reader.activeConnections === before - 1,
      "the worker closed the pipe of the ended PTY",
    );
    const thread = reader.workerThreadId;
    const pids = ptys.map((entry) => entry.pty.pid);

    await reader.crashWorker();

    await Promise.all(ptys.map((entry) => entry.exited));
    // Reported only once the process has ended, with a number: the registry must not attach a second client while
    // the first still runs.
    for (const entry of ptys) {
      expect(entry.exitSeen[0]!.processAlive).toBe(false);
      expect(entry.exitSeen[0]!.exitCode).toBeTypeOf("number");
    }
    expect(pids.every((pid) => !alive(pid))).toBe(true);
    // Reported once, even though node-pty sees its output socket close as well.
    await sleep(500);
    expect(ptys.map((entry) => entry.exits())).toEqual([1, 1, 1]);
    expect(done.exits()).toBe(1);
    expect(reader.activeConnections).toBe(0);

    const next = await openCmd();
    await waitFor(() => next.output().includes(">"), "prompt of the next PTY");
    next.pty.write("echo after-%NUMBER_OF_PROCESSORS%-crash\r");
    await waitFor(() => /after-\d+-crash/.test(next.output()), "echo after the crash");
    expect(reader.workerThreadId).toBeTypeOf("number");
    expect(reader.workerThreadId).not.toBe(thread);
  }, 120_000);
});
