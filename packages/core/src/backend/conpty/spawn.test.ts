// `endOnLoss` with a faked node-pty terminal (#65): only an end the core caused counts as lost. The processes are real
// Node children of this test, so `process.kill` behaves as in the core; nothing else is ended.
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type * as NodePty from "node-pty";
import type { ConoutConnection } from "./conout-reader.js";
import type { PtyProcessExit } from "./pty.js";
import { endOnLoss } from "./spawn.js";

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
});

function child(): ChildProcess {
  const started = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(started);
  return started;
}

/** The parts of node-pty's `WindowsTerminal` that `endOnLoss` reads. */
function fakeTerminal(pid: number) {
  const agent: { exitCode?: number; _inSocket: { destroy(): void } } = { _inSocket: { destroy: () => {} } };
  const terminal = {
    pid,
    _isReady: true,
    _agent: agent,
    onExit: () => ({ dispose: () => {} }),
    onData: () => ({ dispose: () => {} }),
    write: () => {},
    resize: () => {},
    kill: () => {},
  };
  return { agent, terminal: terminal as unknown as NodePty.IPty };
}

function fakeConnection() {
  let lost: () => void = () => {};
  const connection = { onLost: (listener: () => void) => (lost = listener), close: () => {} };
  return { lose: () => lost(), connection: connection as unknown as ConoutConnection };
}

function exits(pty: ReturnType<typeof endOnLoss>): Promise<PtyProcessExit> {
  return new Promise((resolve) => pty.onExit(resolve));
}

describe("endOnLoss (#65)", () => {
  it("keeps the exit code when the process ended by itself before node-pty reported it", async () => {
    const gone = child();
    const pid = gone.pid!;
    gone.kill();
    await new Promise((resolve) => gone.once("exit", resolve));
    const { agent, terminal } = fakeTerminal(pid);
    const { lose, connection } = fakeConnection();
    const pty = endOnLoss(terminal, connection);
    const ended = exits(pty);

    lose();
    // node-pty sets the exit code a moment later.
    setTimeout(() => (agent.exitCode = 3), 50);

    expect(await ended).toEqual({ exitCode: 3 });
  });

  it("reports lost when the core ended the process for the loss", async () => {
    const running = child();
    const { agent, terminal } = fakeTerminal(running.pid!);
    running.once("exit", () => (agent.exitCode = 1));
    const { lose, connection } = fakeConnection();
    const pty = endOnLoss(terminal, connection);
    const ended = exits(pty);

    lose();

    expect(await ended).toEqual({ exitCode: 1, lost: true });
    expect(running.exitCode !== null || running.signalCode !== null).toBe(true);
  });
});
