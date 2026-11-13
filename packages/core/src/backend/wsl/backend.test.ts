import { describe, expect, it } from "vitest";
import type { LaunchSpec } from "@termdock/protocol";
import { WslBackend } from "./backend.js";
import type { RunResult } from "./commands.js";
import type { KeepaliveProcess } from "./keepalive.js";
import type { PtyProcess } from "./pty.js";

const spec: LaunchSpec = { backend: "wsl", cwd: "/tmp" };
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const missing: RunResult = { code: 1, stdout: "", stderr: "can't find session: td-x\n" };
const distroMissing: RunResult = { code: 127, stdout: "", stderr: "Wsl/Service/WSL_E_DISTRO_NOT_FOUND" };

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  killed = false;
  private exitListener: ((event: { exitCode: number }) => void) | undefined;
  write(data: string | Buffer): void {
    this.writes.push(String(data));
  }
  resize(): void {}
  kill(): void {
    this.killed = true;
  }
  onData() {
    return { dispose: () => {} };
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.exitListener = listener;
    return { dispose: () => (this.exitListener = undefined) };
  }
  /** The tmux client ended; ConPTY reports 0 regardless of the program in the session. */
  exit(): void {
    this.exitListener?.({ exitCode: 0 });
  }
}

/** tmux subcommand after `tmux -L <socket>` (skipping `-T RGB`). */
function subcommand(args: readonly string[]): string {
  const index = args.indexOf("tmux");
  if (index < 0) return args.join(" ");
  const rest = args.slice(index + 3);
  return rest[0] === "-T" ? rest[2]! : rest[0]!;
}

interface SetupOptions {
  distro?: string;
  respond?: (args: readonly string[]) => RunResult | undefined;
  failPty?: boolean;
}

function setup(options: SetupOptions = {}) {
  const calls: (readonly string[])[] = [];
  const ptys: { args: readonly string[]; size: unknown; process: FakePtyProcess }[] = [];
  const keepalives: { distro: string; ended: boolean }[] = [];
  /** Pane status per session name; undefined = missing. */
  const panes = new Map<string, string>();
  const backend = new WslBackend({
    socket: "termdock-test",
    ...(options.distro === undefined ? {} : { distro: options.distro }),
    killTimeoutMs: 300,
    run: async (args) => {
      calls.push(args);
      const custom = options.respond?.(args);
      if (custom) return custom;
      const session = args.find((arg) => arg.startsWith("=td-"))?.replace(/^=|:$/g, "");
      switch (subcommand(args)) {
        case "has-session": {
          const status = session ? panes.get(session) : undefined;
          if (status === undefined) return missing;
          return args.includes("display-message") ? ok(`${status}\n`) : ok();
        }
        case "kill-session":
          if (!session || !panes.delete(session)) return missing;
          return ok();
        case "-l -v":
          return ok("  NAME STATE VERSION\r\n  Debian Stopped 2\r\n* Ubuntu Running 2\r\n");
        default:
          return ok("tmux 3.6\n");
      }
    },
    spawnPty: (args, size) => {
      if (options.failPty) throw new Error("no conpty");
      const process = new FakePtyProcess();
      ptys.push({ args, size, process });
      return process;
    },
    spawnKeepalive: (distro): KeepaliveProcess => {
      const entry = { distro, ended: false };
      keepalives.push(entry);
      return { kill: () => (entry.ended = true), onExit: () => {} };
    },
  });
  const running = () => keepalives.filter((k) => !k.ended).map((k) => k.distro);
  return { backend, calls, ptys, panes, running };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("WslBackend", () => {
  it("starts tmux in a PTY with the requested size and holds a keepalive for the distro", async () => {
    const { backend, ptys, running } = setup({ distro: "Ubuntu" });
    await backend.start("s1", spec, { cols: 120, rows: 40 });
    expect(ptys).toHaveLength(1);
    expect(ptys[0]!.args.slice(0, 6)).toEqual(["-d", "Ubuntu", "--cd", "/tmp", "--exec", "tmux"]);
    expect(ptys[0]!.args).toContain("new-session");
    expect(ptys[0]!.size).toEqual({ cols: 120, rows: 40 });
    expect(running()).toEqual(["Ubuntu"]);
  });

  it("uses the distro of the spec, else the WSL default (looked up once)", async () => {
    const { backend, ptys, calls } = setup();
    await backend.start("s1", { ...spec, distro: "Debian" }, { cols: 80, rows: 24 });
    await backend.start("s2", spec, { cols: 80, rows: 24 });
    await backend.start("s3", spec, { cols: 80, rows: 24 });
    expect(ptys.map((p) => p.args[1])).toEqual(["Debian", "Ubuntu", "Ubuntu"]);
    expect(calls.filter((args) => args.join(" ") === "-l -v")).toHaveLength(1);
  });

  it("removes a leftover session whose program already ended before starting", async () => {
    const { backend, panes, calls } = setup({ distro: "Ubuntu" });
    panes.set("td-s1", "1 0 ");
    await backend.start("s1", spec, { cols: 80, rows: 24 });
    expect(calls.map(subcommand)).toEqual(["has-session", "kill-session"]);
  });

  it("releases the keepalive when the PTY cannot be spawned", async () => {
    const { backend, running } = setup({ distro: "Ubuntu", failPty: true });
    await expect(backend.start("s1", spec, { cols: 80, rows: 24 })).rejects.toThrow(/conpty/);
    expect(running()).toEqual([]);
  });

  it("exists reports live sessions only and throws when WSL fails", async () => {
    let wslDown = false;
    const { backend, panes, running } = setup({
      distro: "Ubuntu",
      respond: () => (wslDown ? distroMissing : undefined),
    });
    panes.set("td-alive", "0  ");
    panes.set("td-dead", "1 3 ");
    expect(await backend.exists("alive", spec)).toBe(true);
    expect(running()).toEqual(["Ubuntu"]);
    expect(await backend.exists("dead", spec)).toBe(false);
    expect(await backend.exists("none", spec)).toBe(false);
    wslDown = true;
    await expect(backend.exists("alive", spec)).rejects.toThrow(/WSL_E_DISTRO_NOT_FOUND/);
  });

  it("kill resolves once has-session no longer finds the session and drops the keepalive", async () => {
    const { backend, panes, calls, running } = setup({ distro: "Ubuntu" });
    await backend.start("s1", spec, { cols: 80, rows: 24 });
    panes.set("td-s1", "0  ");
    await backend.kill("s1", spec);
    expect(calls.slice(-2).map(subcommand)).toEqual(["kill-session", "has-session"]);
    expect(running()).toEqual([]);
  });

  it("kill rejects when the session survives the deadline", async () => {
    const { backend, panes } = setup({
      distro: "Ubuntu",
      respond: (args) => (subcommand(args) === "kill-session" ? ok() : undefined),
    });
    panes.set("td-s1", "0  ");
    await expect(backend.kill("s1", spec)).rejects.toThrow(/still exists/);
  });

  it("reports the exit code when the program ended and removes the session", async () => {
    const { backend, ptys, panes, running } = setup({ distro: "Ubuntu" });
    const pty = await backend.start("s1", spec, { cols: 80, rows: 24 });
    const exits: unknown[] = [];
    pty.onExit((event) => exits.push(event));
    panes.set("td-s1", "1 7 ");
    ptys[0]!.process.exit();
    await flush();
    expect(exits).toEqual([{ exitCode: 7 }]);
    expect(panes.has("td-s1")).toBe(false);
    expect(running()).toEqual([]);
  });

  it("reports a lost client without exit code and keeps session and keepalive", async () => {
    const { backend, ptys, panes, running } = setup({ distro: "Ubuntu" });
    const pty = await backend.start("s1", spec, { cols: 80, rows: 24 });
    const exits: unknown[] = [];
    pty.onExit((event) => exits.push(event));
    panes.set("td-s1", "0  ");
    ptys[0]!.process.exit();
    await flush();
    expect(exits).toEqual([{}]);
    expect(panes.has("td-s1")).toBe(true);
    expect(running()).toEqual(["Ubuntu"]);
  });

  it("releases the keepalive when the state after a lost client cannot be determined", async () => {
    let broken = false;
    const { backend, ptys, running } = setup({
      distro: "Ubuntu",
      respond: (args) => (broken && args.includes("display-message") ? distroMissing : undefined),
    });
    const pty = await backend.start("s1", spec, { cols: 80, rows: 24 });
    const exits: unknown[] = [];
    pty.onExit((event) => exits.push(event));
    broken = true;
    ptys[0]!.process.exit();
    await flush();
    expect(exits).toEqual([{}]);
    expect(running()).toEqual([]);
  });

  it("dispose of the PTY ends only the client", async () => {
    const { backend, ptys, calls, running } = setup({ distro: "Ubuntu" });
    const pty = await backend.start("s1", spec, { cols: 80, rows: 24 });
    const before = calls.length;
    pty.dispose();
    expect(ptys[0]!.process.killed).toBe(true);
    expect(calls.length).toBe(before);
    expect(running()).toEqual(["Ubuntu"]);
  });

  it("attaches with attach-session", async () => {
    const { backend, ptys } = setup({ distro: "Ubuntu" });
    await backend.attach("s1", spec, { cols: 80, rows: 24 });
    expect(ptys[0]!.args).toContain("attach-session");
    expect(ptys[0]!.args.at(-1)).toBe("=td-s1");
  });

  it("returns screen and cursor as snapshot", async () => {
    const { backend } = setup({
      distro: "Ubuntu",
      respond: (args) => (args.includes("capture-pane") ? ok("a\nb\n2 1\n") : undefined),
    });
    const snapshot = await backend.snapshot("s1", spec);
    expect(new TextDecoder().decode(snapshot?.data)).toBe("a\r\nb");
    expect(snapshot?.cursor).toEqual({ x: 2, y: 1 });
  });

  it("returns no snapshot for a missing session and throws when WSL fails", async () => {
    expect(await setup({ distro: "Ubuntu" }).backend.snapshot("gone", spec)).toBeUndefined();
    const down = setup({ distro: "Ubuntu", respond: () => distroMissing });
    await expect(down.backend.snapshot("s1", spec)).rejects.toThrow(/WSL_E_DISTRO_NOT_FOUND/);
  });

  it("is available when tmux runs in the distro, not when the distro is missing", async () => {
    expect(await setup({ distro: "Ubuntu" }).backend.available()).toBe(true);
    expect(await setup({ distro: "Nope", respond: () => distroMissing }).backend.available()).toBe(false);
  });

  it("dispose stops all keepalives", async () => {
    const { backend, running } = setup();
    await backend.start("s1", spec, { cols: 80, rows: 24 });
    await backend.start("s2", { ...spec, distro: "Debian" }, { cols: 80, rows: 24 });
    expect(running().sort()).toEqual(["Debian", "Ubuntu"]);
    backend.dispose();
    expect(running()).toEqual([]);
  });
});
