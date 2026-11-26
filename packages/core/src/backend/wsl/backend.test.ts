import { describe, expect, it } from "vitest";
import type { LaunchSpec } from "@termdock/protocol";
import { WslBackend } from "./backend.js";
import type { RunResult } from "./commands.js";
import type { KeepaliveProcess } from "./keepalive.js";
import type { PtyProcess } from "../conpty/pty.js";

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

  it("resolves a missing distro to the configured one, else the WSL default, and keeps a given one", async () => {
    expect(await setup().backend.resolveLaunch(spec)).toEqual({ ...spec, distro: "Ubuntu" });
    expect(await setup({ distro: "Debian" }).backend.resolveLaunch(spec)).toEqual({
      ...spec,
      distro: "Debian",
    });
    const given: LaunchSpec = { ...spec, distro: "Alpine" };
    expect(await setup().backend.resolveLaunch(given)).toBe(given);
  });

  it("removes a leftover session whose program already ended before starting", async () => {
    const { backend, panes, calls } = setup({ distro: "Ubuntu" });
    panes.set("td-s1", "1 0 ");
    await backend.start("s1", spec, { cols: 80, rows: 24 });
    // Besides the check of the working directory (issue #113) and the keepalive take-over (issue #140).
    expect(calls.filter((args) => !args.includes("test") && !args.includes("pkill")).map(subcommand)).toEqual(
      ["has-session", "kill-session"],
    );
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
    await flush();
    expect(running()).toEqual(["Ubuntu"]);
    expect(await backend.exists("dead", spec)).toBe(false);
    expect(await backend.exists("none", spec)).toBe(false);
    wslDown = true;
    await expect(backend.exists("alive", spec)).rejects.toThrow(/WSL_E_DISTRO_NOT_FOUND/);
  });

  it("listLive asks tmux once per distro and reports live sessions like exists (issue #134)", async () => {
    const lists: string[] = [];
    const { backend, calls } = setup({
      respond: (args) => {
        if (subcommand(args) !== "list-sessions") return undefined;
        lists.push(args[1]!);
        return args[1] === "Ubuntu"
          ? ok("td-alive 0\ntd-dead 1\ntd-other 0\nunrelated 0\n")
          : ok("td-debian 0\n");
      },
    });
    const live = await backend.listLive([
      { id: "alive", spec },
      { id: "dead", spec },
      { id: "none", spec: { ...spec, distro: "Ubuntu" } },
      { id: "debian", spec: { ...spec, distro: "Debian" } },
    ]);
    expect(live).toEqual(new Set(["alive", "debian"]));
    expect(lists.sort()).toEqual(["Debian", "Ubuntu"]);
    expect(calls.find((args) => subcommand(args) === "list-sessions")).toEqual([
      "-d",
      expect.any(String),
      "--cd",
      "~",
      "--exec",
      "tmux",
      "-L",
      "termdock-test",
      "list-sessions",
      "-F",
      "#{session_name} #{pane_dead}",
    ]);
  });

  it("listLive reports nothing alive when the socket has no tmux server", async () => {
    const { backend, running } = setup({
      distro: "Ubuntu",
      respond: (args) =>
        subcommand(args) === "list-sessions"
          ? { code: 1, stdout: "", stderr: "no server running on /tmp/tmux-1000/termdock-test\n" }
          : undefined,
    });
    expect(await backend.listLive([{ id: "a", spec }])).toEqual(new Set());
    await flush();
    expect(running()).toEqual([]);
  });

  it("listLive answers undefined and leaves the keepalive alone when one distro fails", async () => {
    const { backend, running } = setup({
      respond: (args) => {
        if (subcommand(args) !== "list-sessions") return undefined;
        return args[1] === "Debian" ? distroMissing : ok("td-a 0\n");
      },
    });
    const live = await backend.listLive([
      { id: "a", spec: { ...spec, distro: "Ubuntu" } },
      { id: "b", spec: { ...spec, distro: "Debian" } },
    ]);
    expect(live).toBeUndefined();
    await flush();
    expect(running()).toEqual([]);
  });

  it("listLive keeps the keepalive bookkeeping of exists: one take-over, one keepalive per distro", async () => {
    const { backend, calls, panes, running } = setup({
      distro: "Ubuntu",
      respond: (args) => (subcommand(args) === "list-sessions" ? ok("td-a 0\ntd-b 0\ntd-c 1\n") : undefined),
    });
    const live = await backend.listLive(["a", "b", "c"].map((id) => ({ id, spec })));
    expect(live).toEqual(new Set(["a", "b"]));
    await flush();
    expect(running()).toEqual(["Ubuntu"]);
    expect(calls.filter((args) => args.includes("pkill"))).toHaveLength(1);
    // Ending the first live session keeps the keepalive; ending the second one stops it.
    panes.set("td-a", "0  ");
    panes.set("td-b", "0  ");
    await backend.kill("a", spec);
    expect(running()).toEqual(["Ubuntu"]);
    await backend.kill("b", spec);
    expect(running()).toEqual([]);
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
      respond: (args) => (args.includes("capture-pane") ? ok("a\nb\n2 1 1\n") : undefined),
    });
    const snapshot = await backend.snapshot("s1", spec);
    expect(new TextDecoder().decode(snapshot?.data)).toBe("a\r\nb\x1b[0m\x1b[2;3H\x1b[?25h");
    expect(snapshot?.cursor).toEqual({ x: 2, y: 1 });
  });

  it("redraws every client of the session with refresh-client (issue #34)", async () => {
    const { backend, calls } = setup({
      distro: "Ubuntu",
      respond: (args) => (args.includes("list-clients") ? ok("/dev/pts/3\n/dev/pts/5\n") : undefined),
    });
    await backend.redraw("s1", spec);
    expect(calls.map(subcommand)).toEqual(["list-clients", "refresh-client", "refresh-client"]);
    expect(calls.slice(1).map((args) => args.at(-1))).toEqual(["/dev/pts/3", "/dev/pts/5"]);
  });

  it("still redraws the other clients when one of them is gone (PR #39)", async () => {
    const { backend, calls } = setup({
      distro: "Ubuntu",
      respond: (args) => {
        if (args.includes("list-clients")) return ok("/dev/pts/3\n/dev/pts/5\n");
        if (args.includes("/dev/pts/3"))
          return { code: 1, stdout: "", stderr: "can't find client: /dev/pts/3\n" };
        return undefined;
      },
    });
    await backend.redraw("s1", spec);
    expect(calls.filter((args) => subcommand(args) === "refresh-client").map((args) => args.at(-1))).toEqual([
      "/dev/pts/3",
      "/dev/pts/5",
    ]);
  });

  it("throws when listing the clients fails or no client could be redrawn (issue #34)", async () => {
    const down = setup({ distro: "Ubuntu", respond: () => distroMissing });
    await expect(down.backend.redraw("s1", spec)).rejects.toThrow(/WSL_E_DISTRO_NOT_FOUND/);
    const refused = setup({
      distro: "Ubuntu",
      respond: (args) =>
        args.includes("list-clients")
          ? ok("/dev/pts/3\n")
          : { code: 1, stdout: "", stderr: "can't find client: /dev/pts/3\n" },
    });
    await expect(refused.backend.redraw("s1", spec)).rejects.toThrow(/can't find client/);
  });

  it("currentCwd asks tmux once with --cd ~ and a 5 s limit and returns the path (issue #199)", async () => {
    const timeouts: number[] = [];
    const calls: (readonly string[])[] = [];
    const backend = new WslBackend({
      socket: "termdock-test",
      run: async (args, options) => {
        calls.push(args);
        timeouts.push(options.timeoutMs);
        return ok("/home/nic/Projekt Ä\n");
      },
    });
    expect(await backend.currentCwd("s1", { ...spec, distro: "Ubuntu" })).toBe("/home/nic/Projekt Ä");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 5)).toEqual(["-d", "Ubuntu", "--cd", "~", "--exec"]);
    expect(calls[0]!.at(-1)).toBe("#{pane_current_path}");
    expect(timeouts).toEqual([5_000]);
  });

  it("currentCwd gives undefined for a missing session, a WSL failure, a timeout and a bad id", async () => {
    expect(await setup({ distro: "Ubuntu" }).backend.currentCwd("gone", spec)).toBeUndefined();
    expect(
      await setup({ distro: "Ubuntu", respond: () => distroMissing }).backend.currentCwd("s1", spec),
    ).toBe(undefined);
    const slow = setup({
      distro: "Ubuntu",
      respond: () => ({ code: null, stdout: "", stderr: "", timedOut: true }),
    });
    expect(await slow.backend.currentCwd("s1", spec)).toBeUndefined();
    expect(await setup({ distro: "Ubuntu" }).backend.currentCwd("a;b", spec)).toBeUndefined();
    // No distro configured and WSL cannot list one: still no rejection.
    expect(await setup({ respond: () => distroMissing }).backend.currentCwd("s1", spec)).toBeUndefined();
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

  it("dispose leaves the keepalives running for the next core (issue #140)", async () => {
    const { backend, running } = setup();
    await backend.start("s1", spec, { cols: 80, rows: 24 });
    await backend.start("s2", { ...spec, distro: "Debian" }, { cols: 80, rows: 24 });
    await flush();
    expect(running().sort()).toEqual(["Debian", "Ubuntu"]);
    backend.dispose();
    expect(running().sort()).toEqual(["Debian", "Ubuntu"]);
  });

  it("dispose resolves only once the closes of the PTYs are done (issue #160)", async () => {
    let closed: (done: boolean) => void = () => {};
    const lines: string[] = [];
    const backend = new WslBackend({
      socket: "termdock-test",
      distro: "Ubuntu",
      run: async () => ok(),
      spawnPty: () => new FakePtyProcess(),
      spawnKeepalive: () => ({ kill: () => {}, onExit: () => {} }),
      ptysClosed: () => new Promise<boolean>((resolve) => (closed = resolve)),
      log: (line) => lines.push(line),
    });
    let done = false;
    const disposed = backend.dispose().then(() => (done = true));
    for (let i = 0; i < 5; i++) await flush();
    expect(done).toBe(false);
    closed(true);
    await disposed;
    expect(done).toBe(true);
    expect(lines).toEqual([]);
  });

  it("dispose logs how many PTY closes are still open when the wait for them gave up (issue #160)", async () => {
    const lines: string[] = [];
    const backend = new WslBackend({
      socket: "termdock-test",
      distro: "Ubuntu",
      run: async () => ok(),
      spawnPty: () => new FakePtyProcess(),
      spawnKeepalive: () => ({ kill: () => {}, onExit: () => {} }),
      ptysClosed: async () => false,
      pendingPtyCloses: () => 3,
      log: (line) => lines.push(line),
    });

    await backend.dispose();

    expect(lines).toEqual(["3 PTY close(s) still open after 15000 ms; the core ends without them"]);
  });

  it("starts the keepalive only after the PTY of tmux, so the tmux server exists (review PR #148)", async () => {
    const order: string[] = [];
    const backend = new WslBackend({
      socket: "termdock-test",
      distro: "Ubuntu",
      run: async (args) => (args.includes("display-message") ? missing : ok()),
      spawnPty: () => {
        order.push("pty");
        return new FakePtyProcess();
      },
      spawnKeepalive: () => {
        order.push("keepalive");
        return { kill: () => {}, onExit: () => {} };
      },
    });
    await backend.start("s1", spec, { cols: 80, rows: 24 });
    await flush();
    expect(order).toEqual(["pty", "keepalive"]);
    await backend.dispose();
  });

  it("hands a keepalive over for a start whose PTY is still being spawned at dispose (review PR #148)", async () => {
    const order: string[] = [];
    let ptyReady: (process: FakePtyProcess) => void = () => {};
    const backend = new WslBackend({
      socket: "termdock-test",
      distro: "Ubuntu",
      run: async (args) => {
        if (args.includes("pkill")) order.push("takeOver");
        return args.includes("display-message") ? missing : ok();
      },
      spawnPty: () => {
        order.push("pty");
        return new Promise<FakePtyProcess>((resolve) => (ptyReady = resolve));
      },
      spawnKeepalive: () => {
        order.push("keepalive");
        return { kill: () => {}, onExit: () => {} };
      },
    });
    const starting = backend.start("s1", spec, { cols: 80, rows: 24 });
    while (!order.includes("pty")) await flush();
    const disposed = backend.dispose();
    ptyReady(new FakePtyProcess());
    await starting;
    await disposed;
    // The session was known before its PTY: the take-over runs, then exactly one keepalive is handed over.
    expect(order).toEqual(["pty", "takeOver", "keepalive"]);
    await expect(backend.start("s2", spec, { cols: 80, rows: 24 })).rejects.toThrow(/closed/);
    expect(order.filter((step) => step === "pty")).toHaveLength(1);
  });

  it("ends left-behind keepalives of its socket once per distro before its first keepalive (issue #140)", async () => {
    const { backend, calls, running } = setup({ distro: "Ubuntu" });
    await backend.start("s1", spec, { cols: 80, rows: 24 });
    await backend.start("s2", spec, { cols: 80, rows: 24 });
    await flush();
    const takeOvers = calls.filter((args) => args.includes("pkill"));
    expect(takeOvers).toEqual([
      [
        "-d",
        "Ubuntu",
        "--cd",
        "~",
        "--exec",
        "pkill",
        "-x",
        "-f",
        "tmux -L termdock-test wait-for termdock-keepalive",
      ],
    ]);
    expect(running()).toEqual(["Ubuntu"]);
  });

  it("lists the distros with its own timeout and fails with the reason (issue #64)", async () => {
    const timeouts: number[] = [];
    let answer: RunResult = ok("  NAME STATE VERSION\r\n* Ubuntu Running 2\r\n  Debian Stopped 2\r\n");
    const backend = new WslBackend({
      commandTimeoutMs: 15_000,
      run: async (args, options) => {
        expect(args).toEqual(["-l", "-v"]);
        timeouts.push(options.timeoutMs);
        return answer;
      },
    });
    expect(await backend.distros({ timeoutMs: 5_000 })).toEqual({
      names: ["Ubuntu", "Debian"],
      defaultDistro: "Ubuntu",
    });
    await backend.distros();
    expect(timeouts).toEqual([5_000, 15_000]);
    answer = { code: null, stdout: "", stderr: "", timedOut: true };
    await expect(backend.distros({ timeoutMs: 5_000 })).rejects.toThrow(/timed out/);
    // Without WSL, wsl.exe ignores WSL_UTF8 and writes UTF-16 (PR #115 review).
    answer = { code: 1, stdout: "", stderr: "N\0o\0 \0W\0S\0L\0" };
    await expect(backend.distros()).rejects.toThrow(/^wsl\.exe -l -v failed \(exit 1\): No WSL$/);
  });
});

// Issue #113 (openspec change missing-cwd-warning): the start checks the working directory and warns.
describe("WslBackend: missing working directory", () => {
  const isCwdCheck = (args: readonly string[]) => args.includes("test");
  const start = (backend: WslBackend, cwd: string) =>
    backend.start("s1", { backend: "wsl", distro: "Ubuntu", cwd }, { cols: 80, rows: 24 });

  it("checks the directory with test -d as an argument array and starts with a cwd_missing warning", async () => {
    const { backend, calls, ptys } = setup({
      respond: (args) => (isCwdCheck(args) ? { code: 1, stdout: "", stderr: "" } : undefined),
    });

    const pty = await start(backend, "/srv/api; rm -rf ~");

    expect(calls.filter(isCwdCheck)).toEqual([
      ["-d", "Ubuntu", "--cd", "~", "--exec", "test", "-d", "/srv/api; rm -rf ~"],
    ]);
    expect(ptys).toHaveLength(1);
    expect(pty.warnings).toEqual([{ code: "cwd_missing", path: "/srv/api; rm -rf ~", distro: "Ubuntu" }]);
  });

  it("has no warning when the directory exists", async () => {
    const { backend } = setup({ respond: (args) => (isCwdCheck(args) ? ok() : undefined) });
    expect((await start(backend, "/srv")).warnings).toBeUndefined();
  });

  it.each([
    ["timed out", { code: null, stdout: "", stderr: "", timedOut: true }],
    ["wsl.exe failed", { code: 1, stdout: "", stderr: "Wsl/Service/E_UNEXPECTED" }],
    ["distro missing", distroMissing],
  ] as const)("starts without a warning when the check %s", async (_name, result) => {
    const { backend, ptys } = setup({ respond: (args) => (isCwdCheck(args) ? result : undefined) });
    expect((await start(backend, "/srv/api")).warnings).toBeUndefined();
    expect(ptys).toHaveLength(1);
  });

  it("starts without a warning when the check throws", async () => {
    const { backend, ptys } = setup({
      respond: (args) => {
        if (isCwdCheck(args)) throw new Error("spawn wsl.exe ENOENT");
        return undefined;
      },
    });
    expect((await start(backend, "/srv/api")).warnings).toBeUndefined();
    expect(ptys).toHaveLength(1);
  });

  it.each([["~"], ["~/src"], ["relative/dir"], ["/" + "a".repeat(512)]])("does not check %s", async (cwd) => {
    const { backend, calls } = setup({ respond: () => ({ code: 1, stdout: "", stderr: "" }) });
    await start(backend, cwd).catch(() => {});
    expect(calls.filter(isCwdCheck)).toEqual([]);
  });

  it("gives the check its own timeout", async () => {
    const timeouts: number[] = [];
    const backend = new WslBackend({
      socket: "termdock-test",
      commandTimeoutMs: 15_000,
      cwdCheckTimeoutMs: 1_234,
      run: async (args, options) => {
        if (isCwdCheck(args)) timeouts.push(options.timeoutMs);
        return isCwdCheck(args) ? ok() : missing;
      },
      spawnPty: () => new FakePtyProcess(),
      spawnKeepalive: () => ({ kill: () => {}, onExit: () => {} }),
    });
    await start(backend, "/srv");
    expect(timeouts).toEqual([1_234]);
    backend.dispose();
  });

  it("runs the check alongside the status call of the start, not after it", async () => {
    let inFlight = 0;
    let most = 0;
    const backend = new WslBackend({
      socket: "termdock-test",
      run: async (args) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return isCwdCheck(args) ? { code: 1, stdout: "", stderr: "" } : missing;
      },
      spawnPty: () => new FakePtyProcess(),
      spawnKeepalive: () => ({ kill: () => {}, onExit: () => {} }),
    });
    const pty = await start(backend, "/srv/api");
    expect(most).toBe(2);
    expect(pty.warnings).toHaveLength(1);
    backend.dispose();
  });

  it("has no warning when the start joins a session that still runs", async () => {
    const { backend, panes } = setup({
      respond: (args) => (isCwdCheck(args) ? { code: 1, stdout: "", stderr: "" } : undefined),
    });
    panes.set("td-s1", "0  ");
    expect((await start(backend, "/srv/api")).warnings).toBeUndefined();
  });

  it("does not wait for the check when the start joins a session that still runs (review PR #113)", async () => {
    const backend = new WslBackend({
      socket: "termdock-test",
      // The check never answers; the status says the session lives.
      run: (args) => (isCwdCheck(args) ? new Promise<RunResult>(() => {}) : Promise.resolve(ok("0  \n"))),
      spawnPty: () => new FakePtyProcess(),
      spawnKeepalive: () => ({ kill: () => {}, onExit: () => {} }),
    });
    const pty = await start(backend, "/srv/api");
    expect(pty.warnings).toBeUndefined();
    backend.dispose();
  });

  it("waits at most cwdCheckGraceMs for the check after the status call, then starts without a warning (review PR #126)", async () => {
    let finishCheck: (result: RunResult) => void = () => {};
    const backend = new WslBackend({
      socket: "termdock-test",
      cwdCheckGraceMs: 50,
      // The check hangs (a stuck mount under /mnt); the status says there is no session yet.
      run: (args) =>
        isCwdCheck(args)
          ? new Promise<RunResult>((resolve) => (finishCheck = resolve))
          : Promise.resolve(missing),
      spawnPty: () => new FakePtyProcess(),
      spawnKeepalive: () => ({ kill: () => {}, onExit: () => {} }),
    });
    const started = Date.now();
    const pty = await start(backend, "/mnt/share/api");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(pty.warnings).toBeUndefined();
    // A late answer changes nothing.
    finishCheck({ code: 1, stdout: "", stderr: "" });
    await flush();
    expect(pty.warnings).toBeUndefined();
    backend.dispose();
  });

  it("does not check on attach", async () => {
    const { backend, calls } = setup({ respond: (args) => (isCwdCheck(args) ? ok() : undefined) });
    const pty = await backend.attach(
      "s1",
      { backend: "wsl", distro: "Ubuntu", cwd: "/srv/api" },
      { cols: 80, rows: 24 },
    );
    expect(calls.filter(isCwdCheck)).toEqual([]);
    expect(pty.warnings).toBeUndefined();
  });
});
