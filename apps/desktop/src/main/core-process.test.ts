import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { coreEntryPath, startDetachedCore } from "./core-process.js";
import type { SpawnFn } from "./core-process.js";

function fakeSpawn(): { spawn: SpawnFn; child: EventEmitter & { unref: () => void }; calls: unknown[][] } {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  const calls: unknown[][] = [];
  const spawn: SpawnFn = (command, args, options) => {
    calls.push([command, args, options]);
    return child;
  };
  return { spawn, child, calls };
}

describe("startDetachedCore", () => {
  it("runs the core entry with Electron as Node, detached and without a console window", () => {
    const { spawn, child, calls } = fakeSpawn();
    Object.assign(child, { pid: 4711 });

    const pid = startDetachedCore({
      execPath: "C:\\app\\electron.exe",
      entry: "C:\\app\\core\\termdock-core.js",
      env: { PATH: "C:\\Windows", TERMDOCK_PIPE: "\\\\.\\pipe\\x" },
      spawn,
    });

    expect(calls).toHaveLength(1);
    const [command, args, options] = calls[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe("C:\\app\\electron.exe");
    expect(args).toEqual(["C:\\app\\core\\termdock-core.js"]);
    expect(options).toMatchObject({ detached: true, stdio: "ignore", windowsHide: true });
    expect(options["env"]).toEqual({
      PATH: "C:\\Windows",
      TERMDOCK_PIPE: "\\\\.\\pipe\\x",
      ELECTRON_RUN_AS_NODE: "1",
    });
    // The app must be able to exit while the core keeps running.
    expect(child.unref).toHaveBeenCalled();
    // The screenshot mode needs it to end its own core when nothing else works.
    expect(pid).toBe(4711);
  });

  it("reports a spawn error instead of crashing the main process", () => {
    const { spawn, child } = fakeSpawn();
    const onError = vi.fn();

    startDetachedCore({ execPath: "x.exe", entry: "core.js", env: {}, spawn, onError });
    child.emit("error", new Error("spawn ENOENT"));

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "spawn ENOENT" }));
  });
});

describe("coreEntryPath", () => {
  it("points at the built termdock-core entry of the core package when run from the repo", () => {
    const entry = coreEntryPath({ packaged: false, resourcesPath: "C:\\electron\\resources" });

    expect(entry.replace(/\\/g, "/")).toMatch(/packages\/core\/dist\/bin\/termdock-core\.js$/);
    expect(existsSync(entry)).toBe(true);
  });

  it("points below app.asar.unpacked of the resources folder in the installed app", () => {
    const resourcesPath = "C:\\Users\\u\\AppData\\Local\\Programs\\TermDock\\resources";

    const entry = coreEntryPath({ packaged: true, resourcesPath });

    // Outside of app.asar: the core runs as plain Node and loads node-pty from the unpacked folder.
    expect(entry.replace(/\\/g, "/")).toBe(
      "C:/Users/u/AppData/Local/Programs/TermDock/resources/app.asar.unpacked/node_modules/@termdock/core/dist/bin/termdock-core.js",
    );
  });
});
