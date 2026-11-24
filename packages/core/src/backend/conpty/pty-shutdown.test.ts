// Ending many PTYs through the core path (issue #160). The PTYs run `cmd.exe` in a ConPTY and need no WSL, so these
// tests run on the Windows CI runner too. Several ConPTY processes ending at the same moment crashed node-pty 1.1.0
// now and then (0xC0000005); the core closes them one after the other.
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { LaunchSpec, SessionId } from "@termdock/protocol";
import { SessionRegistry } from "../../session/registry.js";
import type { Backend } from "../types.js";
import { ConptyPty } from "./pty.js";
import { ptysClosed, spawnConpty } from "./spawn.js";
import type { ConptyProcess } from "./spawn.js";

const SESSIONS = 20;
/** A few rounds only, so the file stays short; `scripts/pty-shutdown-repro.mjs` runs 50 in their own processes. */
const ROUNDS = 5;
const spec: LaunchSpec = { backend: "wsl", cwd: "/" };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** `cmd.exe` PTYs through `spawnConpty` and `ConptyPty`, as the WSL backend runs its tmux clients; no persistence. */
class CmdBackend implements Backend {
  readonly kind = "wsl" as const;
  readonly processes = new Map<SessionId, ConptyProcess>();
  /** Per `kill`: whether the session's PTY process still ran when the backend was asked to end it. */
  readonly aliveAtKill: boolean[] = [];

  available = async () => true;
  attach = async (): Promise<never> => {
    throw new Error("no persistence");
  };
  exists = async (id: SessionId) => this.processes.has(id) && alive(this.processes.get(id)!.pid);
  snapshot = async () => undefined;

  async start(id: SessionId, _spec: LaunchSpec, size: { cols: number; rows: number }) {
    const pty = await spawnConpty("cmd.exe", [], size, process.cwd());
    this.processes.set(id, pty);
    return new ConptyPty(pty, async () => ({}));
  }

  /** As tmux `kill-session`: the program ends by itself. */
  async kill(id: SessionId): Promise<void> {
    const pty = this.processes.get(id);
    if (!pty) return;
    this.aliveAtKill.push(alive(pty.pid));
    if (alive(pty.pid)) pty.write("exit\r");
    await waitFor(() => !alive(pty.pid), "the end of the shell", 10_000);
  }

  pids(): number[] {
    return [...this.processes.values()].map((pty) => pty.pid);
  }
}

const registries: SessionRegistry[] = [];
/** PTYs a test opened without a registry; `afterEach` closes them, also when a check failed first. */
const single: ConptyProcess[] = [];

async function setup(
  count: number,
): Promise<{ registry: SessionRegistry; backend: CmdBackend; ids: SessionId[] }> {
  const backend = new CmdBackend();
  const registry = new SessionRegistry({ backends: [backend], onListenerError: () => {} });
  registries.push(registry);
  const seen = new Set<SessionId>();
  registry.onOutput((event) => seen.add(event.sessionId));
  const ids: SessionId[] = [];
  for (let i = 0; i < count; i++) ids.push((await registry.create({ name: `pty-${i}`, launch: spec })).id);
  // node-pty defers a `kill` until the first output; the core's PTYs have printed by the time they are closed.
  await waitFor(() => ids.every((id) => seen.has(id)), "output of every session");
  return { registry, backend, ids };
}

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.dispose();
  // `kill` runs at most once per PTY; one already closed by its test is not closed again.
  for (const pty of single.splice(0)) pty.kill();
  await ptysClosed();
});

describe.runIf(process.platform === "win32")("ending many PTYs through the core (issue #160)", () => {
  it(`closes ${SESSIONS} PTYs of a disposed registry one after the other, each process ended (${ROUNDS} rounds)`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { registry, backend } = await setup(SESSIONS);
      const pids = backend.pids();
      const started = Date.now();

      registry.dispose();
      // Only queued: before #160 every `kill` ended its process at once, in the same tick.
      expect(pids.filter(alive)).toHaveLength(SESSIONS);
      await expect(ptysClosed()).resolves.toBe(true);

      expect(pids.filter(alive)).toEqual([]);
      expect(Date.now() - started).toBeLessThan(15_000);
    }
  }, 120_000);

  it("killAll closes each PTY before its backend session ends, so no two shells end at once", async () => {
    const { registry, backend, ids } = await setup(10);

    const results = await registry.killAll(ids);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(backend.aliveAtKill).toEqual(ids.map(() => false));
    expect(ids.map((id) => registry.get(id).state)).toEqual(ids.map(() => "Exited"));
    await expect(ptysClosed()).resolves.toBe(true);
  }, 60_000);

  it("ends a PTY closed before its first output; node-pty defers its own kill until then", async () => {
    const pty = await spawnConpty("cmd.exe", [], { cols: 80, rows: 24 }, process.cwd());
    single.push(pty);
    const started = Date.now();

    pty.kill();
    await pty.closed();

    expect(alive(pty.pid)).toBe(false);
    // Within the limit of one PTY: 2 s for its end, 0.5 s after `process.kill`.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);
});
