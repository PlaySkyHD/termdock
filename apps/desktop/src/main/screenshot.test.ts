import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanStaleSockets,
  SCENE_GROUPS,
  screenshotScenes,
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
import type { ExecFileFn, SceneGroup } from "./screenshot.js";
import { describeError, runGroupsWithRetry, SceneGroupError } from "./screenshot.js";

describe("describeError", () => {
  it("names errors, strings and plain objects, never [object Object]", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError(new TypeError("bad"))).toBe("TypeError: bad");
    expect(describeError("text")).toBe("text");
    // A DOMException of the renderer arrives as a plain object.
    expect(describeError({ name: "NotAllowedError", message: "Document is not focused" })).toBe(
      "NotAllowedError: Document is not focused",
    );
    expect(describeError({ code: 3, detail: "x" })).toBe('{"code":3,"detail":"x"}');
    expect(describeError({})).toBe("non-Error object (Object)");
    expect(describeError(undefined)).toBe("undefined");
  });
});

describe("runGroupsWithRetry", () => {
  const setup = (failures: Partial<Record<SceneGroup, number>>) => {
    const played: string[] = [];
    const left = { ...failures };
    const logs: string[] = [];
    let resets = 0;
    const play = async (groups: readonly SceneGroup[]): Promise<void> => {
      for (const group of groups) {
        played.push(group);
        if ((left[group] ?? 0) > 0) {
          left[group] = (left[group] ?? 0) - 1;
          throw new SceneGroupError(group, { name: "Boom", message: `${group} broke` });
        }
      }
    };
    return {
      played,
      logs,
      resets: () => resets,
      run: () =>
        runGroupsWithRetry(
          ["scenario", "tabs", "search"],
          play,
          async () => {
            resets++;
          },
          (text) => logs.push(text),
        ),
    };
  };

  it("plays every group once without a failure", async () => {
    const t = setup({});
    expect(await t.run()).toEqual([]);
    expect(t.played).toEqual(["scenario", "tabs", "search"]);
    expect(t.resets()).toBe(0);
  });

  it("repeats a failed group once, then plays the rest, and reports it", async () => {
    const t = setup({ tabs: 1 });
    expect(await t.run()).toEqual([{ group: "tabs", error: "Boom: tabs broke" }]);
    expect(t.played).toEqual(["scenario", "tabs", "tabs", "search"]);
    expect(t.resets()).toBe(1);
    expect(t.logs).toEqual(["retry tabs: Boom: tabs broke"]);
  });

  it("throws when the repetition fails too, without a third try", async () => {
    const t = setup({ tabs: 2 });
    await expect(t.run()).rejects.toThrow(/scene group tabs failed: Boom: tabs broke/);
    expect(t.played).toEqual(["scenario", "tabs", "tabs"]);
  });

  it("repeats each failing group once", async () => {
    const t = setup({ scenario: 1, search: 1 });
    const retries = await t.run();
    expect(retries.map((retry) => retry.group)).toEqual(["scenario", "search"]);
    expect(t.played).toEqual(["scenario", "scenario", "tabs", "search", "search"]);
  });

  it("does not repeat a failure without a group", async () => {
    let resets = 0;
    await expect(
      runGroupsWithRetry(
        ["tabs"],
        async () => {
          throw new Error("no core");
        },
        async () => {
          resets++;
        },
        () => {},
      ),
    ).rejects.toThrow("no core");
    expect(resets).toBe(0);
  });
});

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

describe("screenshotScenes", () => {
  const base = ["electron.exe", ".", "--screenshot", "P:/shots"];

  it("runs every group without the option, in the fixed order", () => {
    expect(screenshotScenes(base)).toEqual(SCENE_GROUPS);
  });

  it("runs the listed groups, in the fixed order and once each", () => {
    expect(screenshotScenes([...base, "--scenes", "settings,search"])).toEqual(["search", "settings"]);
    expect(screenshotScenes([...base, "--scenes", " snap , snap"])).toEqual(["snap"]);
    // The missing working directory (#113) is the last group and runs alone.
    expect(SCENE_GROUPS.at(-1)).toBe("cwd");
    expect(screenshotScenes([...base, "--scenes", "cwd"])).toEqual(["cwd"]);
  });

  it("reads the option wherever it stands", () => {
    expect(screenshotScenes(["electron.exe", ".", "--scenes", "tabs", "--screenshot", "P:/shots"])).toEqual([
      "tabs",
    ]);
  });

  it("names the valid groups for an unknown name", () => {
    expect(() => screenshotScenes([...base, "--scenes", "search,nope"])).toThrow(/nope/);
    expect(() => screenshotScenes([...base, "--scenes", "nope"])).toThrow(
      new RegExp(SCENE_GROUPS.join(", ")),
    );
  });

  it("refuses the form with an equals sign instead of running every group", () => {
    expect(() => screenshotScenes([...base, "--scenes=search"])).toThrow(/space/);
  });

  it.each([[[]], [[""]], [[","]], [["--other"]]])("refuses an empty list (%j)", (rest) => {
    expect(() => screenshotScenes([...base, "--scenes", ...rest])).toThrow(/at least one/);
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
