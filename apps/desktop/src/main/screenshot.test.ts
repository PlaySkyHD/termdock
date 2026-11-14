import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanStaleSockets,
  staleSockets,
  isolatedCore,
  QuietWatch,
  screenshotDir,
  screenshotProfileDir,
  staleProfileDirs,
  settleWithin,
  stopIsolatedCore,
  wslSocketDeps,
} from "./screenshot.js";
import type { ExecFileFn } from "./screenshot.js";

describe("screenshotDir", () => {
  it("reads the directory after --screenshot", () => {
    expect(screenshotDir(["electron.exe", ".", "--screenshot", "P:/shots"])).toBe("P:/shots");
  });

  it("is undefined without the flag and fails without a directory", () => {
    expect(screenshotDir(["electron.exe", "."])).toBeUndefined();
    expect(() => screenshotDir(["electron.exe", ".", "--screenshot"])).toThrow(/directory/);
    expect(() => screenshotDir(["electron.exe", ".", "--screenshot", "--other"])).toThrow(/directory/);
  });
});

describe("isolatedCore", () => {
  it("uses its own pipe, the given data directory and a tmux socket of its own", () => {
    const core = isolatedCore("C:\\Temp\\td-shot-1", 4242, "ab12");

    expect(core.pipePath).toBe("\\\\.\\pipe\\termdock-core-shot-4242-ab12");
    expect(core.env).toEqual({
      TERMDOCK_PIPE: "\\\\.\\pipe\\termdock-core-shot-4242-ab12",
      TERMDOCK_DATA_DIR: "C:\\Temp\\td-shot-1",
      TERMDOCK_TMUX_SOCKET: "termdock-test-4242-ab12",
    });
  });

  it("keeps the Electron profile of a screenshot run in a temp folder of its process", () => {
    expect(screenshotProfileDir("C:\\Temp", 4242)).toBe("C:\\Temp\\termdock-screenshot-profile-4242");
  });

  it("finds the profiles of earlier runs whose process has ended", () => {
    const entries = [
      "termdock-screenshot-profile-1",
      "termdock-screenshot-profile-2",
      "termdock-screenshot-profile-4242",
      "termdock-screenshot-profile",
      "termdock-shot-abc",
      "other",
    ];
    const alive = new Set([2, 4242]);

    expect(staleProfileDirs("C:\\Temp", entries, 4242, (pid) => alive.has(pid))).toEqual([
      "C:\\Temp\\termdock-screenshot-profile-1",
      "C:\\Temp\\termdock-screenshot-profile",
    ]);
  });
});

describe("staleSockets", () => {
  const dir = "/tmp/tmux-1000";
  const paths = [
    `${dir}/termdock`,
    `${dir}/termdock-test`,
    `${dir}/termdock-test-1-ab12`,
    `${dir}/termdock-test-2-ab12`,
    `${dir}/termdock-test-4242-ab12`,
    `${dir}/termdock-test-3-xyz`,
    `${dir}/termdock-test-3-ab12-extra`,
    `${dir}/termdock-test--ab12`,
    `${dir}/../termdock-test-5-ab12`,
    `/tmp/other/termdock-test-6-ab12`,
    `/tmp/tmux-1000/sub/termdock-test-7-ab12`,
    `${dir}/other`,
  ];

  it("selects only sockets of ended runs and never termdock, termdock-test or its own", () => {
    const alive = new Set([2, 4242]);

    expect(staleSockets(paths, 4242, (pid) => alive.has(pid))).toEqual([`${dir}/termdock-test-1-ab12`]);
  });
});

describe("cleanStaleSockets", () => {
  const dir = "/tmp/tmux-1000";

  it("kills the server of each stale socket and goes on after a failure", async () => {
    const killed: string[] = [];
    const log = vi.fn();
    const result = await cleanStaleSockets(9, {
      listSockets: async () => [
        `${dir}/termdock`,
        `${dir}/termdock-test-1-aa`,
        `${dir}/termdock-test-2-bb`,
        `${dir}/termdock-test-3-cc`,
      ],
      killServer: async (socket) => {
        if (socket.includes("-2-")) throw new Error("boom");
        killed.push(socket);
      },
      isAlive: (pid) => pid === 3,
      log,
    });

    expect(killed).toEqual([`${dir}/termdock-test-1-aa`]);
    expect(result).toEqual([`${dir}/termdock-test-1-aa`]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("termdock-test-2-bb: boom"));
  });

  it("logs and resolves when the sockets cannot be listed", async () => {
    const log = vi.fn();
    const killServer = vi.fn();

    await expect(
      cleanStaleSockets(9, {
        listSockets: () => Promise.reject(new Error("no wsl")),
        killServer,
        isAlive: () => false,
        log,
      }),
    ).resolves.toEqual([]);

    expect(killServer).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no wsl"));
  });
});

describe("settleWithin", () => {
  afterEach(() => vi.useRealTimers());

  it("returns when the promise is done, and at the limit when it hangs", async () => {
    vi.useFakeTimers();
    await settleWithin(undefined, 1_000);
    await settleWithin(Promise.resolve(), 1_000);

    let done = false;
    const waiting = settleWithin(new Promise(() => undefined), 1_000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toBe(true);
  });
});

describe("wslSocketDeps", () => {
  type Reply = { code?: number; stdout?: string; stderr?: string };

  /** An `execFile` that answers each call from `reply` and records the arguments. */
  function fakeExec(reply: (args: readonly string[]) => Reply) {
    const calls: { file: string; args: readonly string[] }[] = [];
    const exec: ExecFileFn = (file, args, _options, callback) => {
      calls.push({ file, args });
      const { code, stdout = "", stderr = "" } = reply(args);
      callback(
        code === undefined ? null : Object.assign(new Error(`exit ${code}`), { code }),
        stdout,
        stderr,
      );
    };
    return { exec, calls };
  }

  const socket = "/tmp/tmux-1000/termdock-test-7-ab12";

  it("lists socket paths with find as an argument array and tolerates its exit code 1", async () => {
    const { exec, calls } = fakeExec(() => ({ code: 1, stdout: `${socket}\n`, stderr: "Permission denied" }));

    await expect(wslSocketDeps(exec).listSockets()).resolves.toEqual([socket]);

    expect(calls).toEqual([
      {
        file: "wsl.exe",
        args: [
          "--cd",
          "~",
          "--exec",
          "find",
          "/tmp",
          "-maxdepth",
          "2",
          "-path",
          "/tmp/tmux-*/termdock-test-*",
          "-type",
          "s",
          "-printf",
          "%p\\n",
        ],
      },
    ]);
  });

  it("fails when find fails with another exit code", async () => {
    const { exec } = fakeExec(() => ({ code: 2, stderr: "broken" }));

    await expect(wslSocketDeps(exec).listSockets()).rejects.toThrow(/broken/);
  });

  it("ends the server with -L and the socket name, then removes the socket file tmux leaves", async () => {
    const { exec, calls } = fakeExec(() => ({}));

    await wslSocketDeps(exec).killServer(socket);

    expect(calls.map((call) => call.args)).toEqual([
      ["--cd", "~", "--exec", "tmux", "-L", "termdock-test-7-ab12", "kill-server"],
      ["--cd", "~", "--exec", "rm", "-f", "--", socket],
    ]);
  });

  it.each(["no server running on /tmp/x", "error connecting to /tmp/x (No such file or directory)"])(
    "removes the socket file when no server is left (%s)",
    async (stderr) => {
      const { exec, calls } = fakeExec((args) => (args.includes("tmux") ? { code: 1, stderr } : {}));

      await wslSocketDeps(exec).killServer(socket);

      expect(calls.map((call) => call.args.slice(3))).toEqual([
        ["tmux", "-L", "termdock-test-7-ab12", "kill-server"],
        ["rm", "-f", "--", socket],
      ]);
    },
  );

  it("rethrows other kill-server errors without removing the file", async () => {
    const { exec, calls } = fakeExec(() => ({ code: 1, stderr: "permission denied" }));

    await expect(wslSocketDeps(exec).killServer(socket)).rejects.toThrow(/permission denied/);

    expect(calls).toHaveLength(1);
  });

  it("refuses paths that are not screenshot sockets", async () => {
    const { exec, calls } = fakeExec(() => ({}));

    await expect(wslSocketDeps(exec).killServer("/tmp/tmux-1000/termdock")).rejects.toThrow(
      /not a screenshot/,
    );
    await expect(wslSocketDeps(exec).killServer("/home/nic/x")).rejects.toThrow(/not a screenshot/);

    expect(calls).toEqual([]);
  });
});

describe("stopIsolatedCore", () => {
  /** A core process that ends `exitAfterMs` after a shutdown request or a kill. */
  function fakeProcess() {
    const state = { alive: true, time: 0, shutdowns: [] as unknown[], killed: [] as number[] };
    const deps = {
      kill: (pid: number) => {
        state.killed.push(pid);
        state.alive = false;
      },
      isAlive: () => state.alive,
      sleep: async (ms: number) => {
        state.time += ms;
      },
    };
    return { state, deps };
  }

  it("ends the core with core.shutdown and its sessions, then waits until the process is gone", async () => {
    const { state, deps } = fakeProcess();
    const close = vi.fn(async () => {});
    const connect = vi.fn(async () => ({
      request: async (_method: string, params: unknown) => {
        state.shutdowns.push(params);
        state.alive = false;
        return { result: {}, payload: new Uint8Array() };
      },
      close,
    }));

    const outcome = await stopIsolatedCore(4711, { ...deps, connect });

    expect(outcome).toBe("shutdown");
    expect(state.shutdowns).toEqual([{ stopSessions: true }]);
    expect(close).toHaveBeenCalled();
    expect(state.killed).toEqual([]);
  });

  it("kills the process by pid when the core does not answer", async () => {
    const { state, deps } = fakeProcess();
    const connect = vi.fn(async () => {
      throw new Error("Cannot connect: ENOENT");
    });

    const outcome = await stopIsolatedCore(4711, { ...deps, connect });

    expect(outcome).toBe("killed");
    expect(state.killed).toEqual([4711]);
  });

  it("does nothing more when no core was started and none answers", async () => {
    const { state, deps } = fakeProcess();
    const connect = vi.fn(async () => {
      throw new Error("Cannot connect: ENOENT");
    });

    expect(await stopIsolatedCore(undefined, { ...deps, connect })).toBe("gone");
    expect(state.killed).toEqual([]);
  });
});

describe("QuietWatch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves once output has been quiet for the given time after the first output", async () => {
    vi.useFakeTimers();
    const watch = new QuietWatch();
    let done = false;
    const waiting = watch.quiet(800, 10_000).then(() => (done = true));

    await vi.advanceTimersByTimeAsync(2_000);
    expect(done).toBe(false); // nothing seen yet: a shell that has not started is not quiet
    watch.saw();
    await vi.advanceTimersByTimeAsync(500);
    watch.saw();
    await vi.advanceTimersByTimeAsync(700);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await waiting;
    expect(done).toBe(true);
  });

  it("fails after the timeout", async () => {
    vi.useFakeTimers();
    const watch = new QuietWatch();
    const waiting = watch.quiet(800, 3_000).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(3_000);

    expect(await waiting).toBeInstanceOf(Error);
  });
});
