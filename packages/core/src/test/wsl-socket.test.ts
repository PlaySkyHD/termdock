import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { killWslTestServer, socketRunPid, staleWslTestSockets, wslTestSocket } from "./wsl-socket.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function wslTestFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "out" || entry === "release") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...wslTestFiles(path));
    else if (entry.endsWith(".wsl.test.ts")) files.push(path);
  }
  return files;
}

describe("WSL test sockets (#147)", () => {
  it("names a socket per call that screenshot runs and the cleanup recognise", () => {
    const a = wslTestSocket();
    const b = wslTestSocket();
    expect(a).toMatch(/^termdock-test-\d+-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(socketRunPid(a)).toBe(process.pid);
    expect(socketRunPid(wslTestSocket(4242))).toBe(4242);
  });

  it("recognises no other socket as a run socket", () => {
    for (const name of [
      "termdock",
      "termdock-test",
      "termdock-test-autostart",
      "termdock-test-keepalive-ab12cd34",
      "x",
    ]) {
      expect(socketRunPid(name)).toBeUndefined();
    }
  });

  it("calls only sockets of ended processes stale", () => {
    const alive = new Set([100, 200]);
    const names = [
      "termdock",
      "termdock-test",
      "termdock-test-100-aaaaaaaa", // live process
      "termdock-test-200-bbbbbbbb", // own process
      "termdock-test-300-cccccccc", // ended
      "termdock-test-keepalive-dddddddd",
    ];
    expect(staleWslTestSockets(names, 200, (pid) => alive.has(pid))).toEqual(["termdock-test-300-cccccccc"]);
  });

  it("refuses to end the server of the shared sockets", async () => {
    await expect(killWslTestServer("Ubuntu", "termdock")).rejects.toThrow("not a WSL test socket");
    await expect(killWslTestServer("Ubuntu", "termdock-test")).rejects.toThrow("not a WSL test socket");
  });

  it("no WSL test file names the fixed socket termdock-test", () => {
    const files = [...wslTestFiles(join(repoRoot, "packages")), ...wslTestFiles(join(repoRoot, "apps"))];
    expect(files.length).toBeGreaterThanOrEqual(5);
    const offenders = files.filter((file) => /["'`]termdock-test["'`]/.test(readFileSync(file, "utf8")));
    expect(offenders.map((file) => relative(repoRoot, file))).toEqual([]);
  });
});
