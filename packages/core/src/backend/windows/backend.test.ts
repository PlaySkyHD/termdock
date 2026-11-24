// Windows backend (issue #65) through the session registry. The sessions run a real `cmd.exe` in a ConPTY and need no
// WSL, so these tests run on the Windows CI runner too. Each test ends only the shells it started.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { LaunchSpec, SessionId, SessionState } from "@termdock/protocol";
import { SessionRegistry } from "../../session/registry.js";
import { spawnConpty } from "../conpty/spawn.js";
import type { PtyProcess, PtyProcessExit } from "../conpty/pty.js";
import type { Disposable } from "../types.js";
import { WindowsBackend } from "./backend.js";
import type { WindowsBackendOptions } from "./backend.js";

const onWindows = process.platform === "win32";
const decoder = new TextDecoder();

interface Setup {
  registry: SessionRegistry;
  backend: WindowsBackend;
  /** PIDs of every shell the backend started, in start order. */
  pids: number[];
  /** Output per session, as text. */
  output: Map<SessionId, string>;
  states: Map<SessionId, SessionState[]>;
}

const setups: Setup[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const { registry, backend } of setups.splice(0)) {
    registry.dispose();
    await backend.dispose();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: WindowsBackendOptions = {}): Setup {
  const pids: number[] = [];
  const backend = new WindowsBackend({
    spawnPty: async (...args) => {
      const pty = await spawnConpty(...args);
      pids.push(pty.pid);
      return pty;
    },
    log: () => {},
    ...options,
  });
  const registry = new SessionRegistry({ backends: [backend], onListenerError: () => {} });
  const output = new Map<SessionId, string>();
  const states = new Map<SessionId, SessionState[]>();
  registry.onOutput(({ sessionId, data }) =>
    output.set(sessionId, (output.get(sessionId) ?? "") + decoder.decode(data)),
  );
  registry.onStateChange(({ sessionId, to }) =>
    states.set(sessionId, [...(states.get(sessionId) ?? []), to]),
  );
  const result = { registry, backend, pids, output, states };
  setups.push(result);
  return result;
}

function tempDir(): string {
  // The long form: cmd prints it so, while `tmpdir()` may hold an 8.3 name.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "termdock-win-")));
  dirs.push(dir);
  return dir;
}

const cmd = (cwd: string, extra: Partial<LaunchSpec> = {}): LaunchSpec => ({
  backend: "windows",
  shell: "cmd",
  cwd,
  ...extra,
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, what: string, last?: () => unknown): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}${last ? `; last: ${JSON.stringify(last())}` : ""}`);
    }
    await sleep(20);
  }
}

/** Types `line` and Enter as the writer `viewId`. */
function type(s: Setup, sessionId: SessionId, viewId: string, line: string): void {
  s.registry.input(sessionId, viewId, `${line}\r`);
}

/** The output of the session contains `text` (cmd echoes the typed line, so callers type `^` inside the marker). */
async function sees(s: Setup, sessionId: SessionId, text: string): Promise<void> {
  await waitFor(
    () => (s.output.get(sessionId) ?? "").includes(text),
    `"${text}" in the output`,
    () => (s.output.get(sessionId) ?? "").slice(-300),
  );
}

describe.runIf(onWindows)("WindowsBackend with cmd.exe (issue #65)", { timeout: 60_000 }, () => {
  it("[V1-15] starts cmd.exe in the working directory, takes input from the writer and delivers the output", async () => {
    const s = setup();
    const dir = tempDir();
    const session = await s.registry.create({ name: "cmd", launch: cmd(dir) });
    expect(session.state).toBe("Detached");
    expect(session.warnings).toBeUndefined();
    await sees(s, session.id, ">");
    const { writer } = await s.registry.attachView(session.id, "v1");
    expect(writer).toBe(true);
    expect(s.registry.get(session.id).state).toBe("Running");
    type(s, session.id, "v1", "echo mark^er-65 & cd");
    await sees(s, session.id, "marker-65");
    await sees(s, session.id, `${dir}\r\n`);
  });

  it("[V1-15] lets only the writer type and resize; the ConPTY takes the new size", async () => {
    const s = setup();
    const session = await s.registry.create({ name: "cmd", launch: cmd(tempDir()) });
    await s.registry.attachView(session.id, "writer");
    await s.registry.attachView(session.id, "reader");
    await sees(s, session.id, ">");
    expect(() => s.registry.input(session.id, "reader", "echo no\r")).toThrow(
      expect.objectContaining({ code: "not_writer" }),
    );
    expect(() => s.registry.resize(session.id, "reader", { cols: 97, rows: 31 })).toThrow(
      expect.objectContaining({ code: "not_writer" }),
    );
    s.registry.resize(session.id, "writer", { cols: 97, rows: 31 });
    // `mode con` names lines and columns in the language of Windows; the numbers are what counts.
    type(s, session.id, "writer", "mode con");
    await waitFor(
      () => /\b31\b[\s\S]*\b97\b/.test(s.output.get(session.id) ?? ""),
      "31 lines and 97 columns from mode con",
      () => (s.output.get(session.id) ?? "").slice(-300),
    );
  });

  it("[V1-15] ends Exited with the exit code of the shell, and exists is false afterwards", async () => {
    const s = setup();
    const session = await s.registry.create({ name: "cmd", launch: cmd(tempDir()) });
    await s.registry.attachView(session.id, "v1");
    await sees(s, session.id, ">");
    type(s, session.id, "v1", "exit 7");
    await waitFor(() => s.registry.get(session.id).state === "Exited", "Exited");
    expect(s.registry.get(session.id).lastExitCode).toBe(7);
    expect(await s.backend.exists(session.id)).toBe(false);
    expect(alive(s.pids[0]!)).toBe(false);
  });

  it("[V1-15] kill ends the shell, Exited with its exit code, no process left", async () => {
    const s = setup();
    const session = await s.registry.create({ name: "cmd", launch: cmd(tempDir()) });
    await sees(s, session.id, ">");
    const pid = s.pids[0]!;
    expect(alive(pid)).toBe(true);
    const killed = await s.registry.kill(session.id);
    expect(killed.state).toBe("Exited");
    expect(killed.lastExitCode).toBeTypeOf("number");
    expect(alive(pid)).toBe(false);
    expect(s.backend.running).toBe(0);
  });

  it("[V1-15] restart starts a new shell after a separator line, never a second one", async () => {
    const s = setup();
    const dir = tempDir();
    const session = await s.registry.create({ name: "cmd", launch: cmd(dir) });
    await s.registry.attachView(session.id, "v1");
    await sees(s, session.id, ">");
    await expect(s.backend.start(session.id, cmd(dir), { cols: 80, rows: 24 })).rejects.toThrow(
      "already has a shell",
    );
    expect(s.pids).toHaveLength(1);
    type(s, session.id, "v1", "exit 3");
    await waitFor(() => s.registry.get(session.id).state === "Exited", "Exited");
    s.output.set(session.id, "");

    const restarted = await s.registry.restart(session.id);
    expect(restarted.state).toBe("Running");
    expect(s.output.get(session.id)).toMatch(/^\r\n--- Neu gestartet \d{4}-\d\d-\d\dT[\d:.]+Z ---\r\n/);
    expect(s.pids).toHaveLength(2);
    expect(s.backend.running).toBe(1);
    type(s, session.id, "v1", "echo aga^in-65");
    await sees(s, session.id, "again-65");
  });

  it("[V1-15] shows a late view the output so far from the raw buffer", async () => {
    const s = setup();
    const session = await s.registry.create({ name: "cmd", launch: cmd(tempDir()) });
    await s.registry.attachView(session.id, "first");
    await sees(s, session.id, ">");
    type(s, session.id, "first", "echo ear^ly-65");
    await sees(s, session.id, "early-65");
    const late = await s.registry.attachView(session.id, "late");
    expect(late.writer).toBe(false);
    expect(decoder.decode(late.snapshot.data)).toContain("early-65");
    expect(late.outputSeq).toBeGreaterThan(0);
  });

  it("[V1-15] archive and delete end the shell; a deleted session leaves no process", async () => {
    const s = setup();
    const first = await s.registry.create({ name: "a", launch: cmd(tempDir()) });
    const second = await s.registry.create({ name: "b", launch: cmd(tempDir()) });
    await sees(s, first.id, ">");
    await sees(s, second.id, ">");
    const [pidA, pidB] = s.pids;
    expect((await s.registry.archive(first.id)).state).toBe("Archived");
    expect(alive(pidA!)).toBe(false);
    await s.registry.delete(first.id);
    await s.registry.kill(second.id);
    await s.registry.delete(second.id);
    expect(alive(pidB!)).toBe(false);
    expect(s.registry.list()).toEqual([]);
    expect(s.backend.running).toBe(0);
  });

  it("[V1-15] starts in the home directory with the warning cwd_missing when the directory is missing", async () => {
    const home = tempDir();
    const s = setup({ home });
    const missing = join(home, "gone-65");
    const session = await s.registry.create({ name: "cmd", launch: cmd(missing) });
    expect(session.warnings).toEqual([{ code: "cwd_missing", path: missing }]);
    await s.registry.attachView(session.id, "v1");
    await sees(s, session.id, ">");
    type(s, session.id, "v1", "cd");
    await sees(s, session.id, `${home}\r\n`);
  });

  it("starts ~ in the home directory without a warning", async () => {
    const home = tempDir();
    const s = setup({ home });
    const session = await s.registry.create({ name: "cmd", launch: cmd("~") });
    expect(session.warnings).toBeUndefined();
    await s.registry.attachView(session.id, "v1");
    await sees(s, session.id, ">");
    type(s, session.id, "v1", "cd");
    await sees(s, session.id, `${home}\r\n`);
  });

  it("gives the shell launch.env and not ELECTRON_RUN_AS_NODE of the core", async () => {
    const s = setup({ env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    const session = await s.registry.create({
      name: "cmd",
      launch: cmd(tempDir(), { env: { TD_VALUE_65: "abc" } }),
    });
    await s.registry.attachView(session.id, "v1");
    await sees(s, session.id, ">");
    type(s, session.id, "v1", "echo x%TD_VALUE_65%y");
    await sees(s, session.id, "xabcy");
    type(s, session.id, "v1", "if defined ELECTRON_RUN_AS_NODE (echo E=y^es) else (echo E=n^o)");
    await sees(s, session.id, "E=no");
  });

  it("runs launch.command as an argument array, without a shell", async () => {
    const s = setup();
    const session = await s.registry.create({
      name: "cmd",
      launch: cmd(tempDir(), { command: ["cmd.exe", "/d", "/c", "echo arg-65 & exit 4"] }),
    });
    await waitFor(() => s.registry.get(session.id).state === "Exited", "Exited");
    expect(s.output.get(session.id)).toContain("arg-65");
    expect(s.registry.get(session.id).lastExitCode).toBe(4);
  });

  it("disposing the backend ends every shell, and a later start is refused", async () => {
    const s = setup();
    const sessions = [
      await s.registry.create({ name: "a", launch: cmd(tempDir()) }),
      await s.registry.create({ name: "b", launch: cmd(tempDir()) }),
    ];
    for (const session of sessions) await sees(s, session.id, ">");
    expect(s.pids.every(alive)).toBe(true);
    await s.backend.dispose();
    expect(s.pids.some(alive)).toBe(false);
    await expect(s.backend.start("late", cmd(tempDir()), { cols: 80, rows: 24 })).rejects.toThrow("closed");
  });
});

/** A PTY process the test ends by hand. */
class FakeProcess implements PtyProcess {
  killed = false;
  private readonly exits = new Set<(event: PtyProcessExit) => void>();
  write(): void {}
  resize(): void {}
  kill(): void {
    this.killed = true;
  }
  onData(): Disposable {
    return { dispose: () => {} };
  }
  onExit(listener: (event: PtyProcessExit) => void): Disposable {
    this.exits.add(listener);
    return { dispose: () => this.exits.delete(listener) };
  }
  end(event: PtyProcessExit): void {
    for (const listener of [...this.exits]) listener(event);
  }
}

describe("WindowsBackend without a real shell", () => {
  const files = { isFile: async () => true, isDirectory: async () => true, home: "C:\\Users\\dev" };

  function fake(options: WindowsBackendOptions = {}) {
    const processes: FakeProcess[] = [];
    const spawned: { file: string; args: readonly string[]; cwd: string }[] = [];
    const backend = new WindowsBackend({
      ...files,
      env: { SystemRoot: "C:\\Windows", Path: "" },
      spawnPty: async (file, args, _size, cwd) => {
        spawned.push({ file, args, cwd });
        const created = new FakeProcess();
        processes.push(created);
        return created;
      },
      ptysClosed: async () => true,
      log: () => {},
      ...options,
    });
    const registry = new SessionRegistry({ backends: [backend], onListenerError: () => {} });
    return { backend, registry, processes, spawned };
  }

  it("a shell whose output was lost becomes Interrupted, not Exited", async () => {
    const { registry, processes } = fake();
    const session = await registry.create({ name: "x", launch: cmd("C:\\") });
    processes[0]!.end({ exitCode: 1, lost: true });
    await waitFor(() => registry.get(session.id).state === "Interrupted", "Interrupted");
    expect(registry.get(session.id).lastExitCode).toBeUndefined();
  });

  it("[V1-15] refuses pwsh when it is not installed, with a message that names it; the session is Interrupted", async () => {
    const { registry, spawned } = fake({ isFile: async () => false });
    const failure = registry.create({
      name: "x",
      launch: { backend: "windows", shell: "pwsh", cwd: "C:\\" },
    });
    await expect(failure).rejects.toMatchObject({
      code: "backend_unavailable",
      message: expect.stringContaining("PowerShell 7 (pwsh.exe) is not installed"),
    });
    expect(registry.list()).toEqual([expect.objectContaining({ state: "Interrupted" })]);
    expect(spawned).toEqual([]);
  });

  it("pins pwsh when installed and powershell otherwise, and the registry stores it", async () => {
    const withPwsh = fake({
      isFile: async (file) => file.endsWith("pwsh.exe"),
      env: { ProgramFiles: "C:\\PF" },
    });
    const session = await withPwsh.registry.create({
      name: "x",
      launch: { backend: "windows", cwd: "C:\\" },
    });
    expect(session.launch.shell).toBe("pwsh");
    expect(withPwsh.spawned[0]).toEqual({
      file: "C:\\PF\\PowerShell\\7\\pwsh.exe",
      args: ["-NoLogo"],
      cwd: "C:\\",
    });
    const without = fake({ isFile: async (file) => file.endsWith("powershell.exe") });
    const second = await without.registry.create({ name: "y", launch: { backend: "windows", cwd: "C:\\" } });
    expect(second.launch.shell).toBe("powershell");
  });

  it("names a command program that is missing or a batch file, without starting anything", async () => {
    const { registry, spawned } = fake({
      isFile: async (file) => file === "D:\\bin\\npm.cmd",
      env: { Path: "D:\\bin" },
    });
    await expect(
      registry.create({ name: "x", launch: cmd("C:\\", { command: ["npm", "run", "dev"] }) }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Program npm is a batch file (npm.cmd): run it as ["cmd.exe"'),
    });
    await expect(
      registry.create({ name: "y", launch: cmd("C:\\", { command: ["nope"] }) }),
    ).rejects.toMatchObject({ message: expect.stringContaining("Program nope was not found in PATH") });
    expect(spawned).toEqual([]);
  });

  it("counts a directory check that does not answer as missing", async () => {
    const { registry, spawned } = fake({ isDirectory: () => new Promise(() => {}), cwdCheckTimeoutMs: 20 });
    const session = await registry.create({ name: "x", launch: cmd("\\\\offline\\share") });
    expect(session.warnings).toEqual([{ code: "cwd_missing", path: "\\\\offline\\share" }]);
    expect(spawned[0]!.cwd).toBe("C:\\Users\\dev");
  });

  it("cannot attach and exists only while the shell runs", async () => {
    const { backend, registry, processes } = fake();
    const session = await registry.create({ name: "x", launch: cmd("C:\\") });
    expect(await backend.exists(session.id)).toBe(true);
    expect(await backend.listLive([{ id: session.id }, { id: "other" }])).toEqual(new Set([session.id]));
    await expect(backend.attach(session.id)).rejects.toThrow("no process to attach to");
    processes[0]!.end({ exitCode: 0 });
    expect(await backend.exists(session.id)).toBe(false);
  });

  it("kill rejects when the shell outlives it", async () => {
    const { backend, registry } = fake({ killReportMs: 10 });
    const session = await registry.create({ name: "x", launch: cmd("C:\\") });
    await expect(backend.kill(session.id)).rejects.toThrow("still runs after kill");
  });
});
