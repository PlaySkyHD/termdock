import { describe, expect, it } from "vitest";
import { FileBridge, parseFileRequest } from "./file-bridge.js";
import type { FileOperations } from "./file-bridge.js";

const wsl = { backend: "wsl", distro: "Ubuntu", path: "/home" } as const;
const win = { backend: "windows", path: "C:\\a" } as const;

function recorder() {
  const calls: unknown[][] = [];
  const answer = { ok: true } as const;
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return answer;
    };
  const files = {
    list: record("list"),
    rename: record("rename"),
    move: record("move"),
    delete: record("delete"),
    download: record("download"),
    reveal: record("reveal"),
    open: record("open"),
  } as unknown as FileOperations;
  return { calls, bridge: new FileBridge(files) };
}

describe("parseFileRequest", () => {
  it("accepts every method of the contract and drops unknown fields", () => {
    expect(parseFileRequest({ method: "list", location: wsl, extra: 1 })).toEqual({
      method: "list",
      location: wsl,
    });
    expect(parseFileRequest({ method: "rename", location: win, newName: "b" })).toEqual({
      method: "rename",
      location: win,
      newName: "b",
    });
    expect(parseFileRequest({ method: "move", location: wsl, targetDir: { ...wsl, path: "/x" } })).toEqual({
      method: "move",
      location: wsl,
      targetDir: { ...wsl, path: "/x" },
    });
    for (const method of ["delete", "download", "reveal", "open"]) {
      expect(parseFileRequest({ method, location: win })).toEqual({ method, location: win });
    }
  });

  it.each<[string, unknown]>([
    ["no object", "list"],
    ["null", null],
    ["array", []],
    ["unknown method", { method: "chmod", location: wsl }],
    ["no method", { location: wsl }],
    ["no location", { method: "list" }],
    ["location is a string", { method: "list", location: "/home" }],
    ["unknown backend", { method: "list", location: { backend: "ssh", path: "/" } }],
    ["wsl without distro", { method: "list", location: { backend: "wsl", path: "/" } }],
    ["distro is no string", { method: "list", location: { backend: "wsl", distro: 1, path: "/" } }],
    ["path is no string", { method: "list", location: { backend: "windows", path: 5 } }],
    ["rename without name", { method: "rename", location: wsl }],
    ["rename with number", { method: "rename", location: wsl, newName: 1 }],
    ["move without target", { method: "move", location: wsl }],
    ["move with bad target", { method: "move", location: wsl, targetDir: { backend: "wsl" } }],
  ])("rejects %s", (_name, raw) => {
    expect(parseFileRequest(raw)).toBeUndefined();
  });
});

describe("FileBridge", () => {
  it("calls the service with the parsed parameters and the window of the caller", async () => {
    const { calls, bridge } = recorder();
    await bridge.call(7, { method: "list", location: wsl });
    await bridge.call(7, { method: "rename", location: wsl, newName: "n" });
    await bridge.call(7, { method: "move", location: wsl, targetDir: win });
    await bridge.call(7, { method: "delete", location: wsl });
    await bridge.call(7, { method: "download", location: wsl });
    await bridge.call(7, { method: "reveal", location: wsl });
    await bridge.call(7, { method: "open", location: wsl });
    expect(calls).toEqual([
      ["list", wsl],
      ["rename", wsl, "n"],
      ["move", wsl, win],
      ["delete", wsl],
      ["download", 7, wsl],
      ["reveal", wsl],
      ["open", wsl],
    ]);
  });

  it("answers EINVAL to a request outside the contract and calls nothing", async () => {
    const { calls, bridge } = recorder();
    for (const raw of [undefined, 5, { method: "exec", location: wsl }, { method: "list" }]) {
      expect(await bridge.call(1, raw)).toEqual({ ok: false, code: "EINVAL" });
    }
    expect(calls).toEqual([]);
  });
});
