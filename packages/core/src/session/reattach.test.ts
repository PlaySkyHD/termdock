// Re-attaching after a lost backend client and releasing the registry (issue #13, spec session-lifecycle).
import { describe, expect, it } from "vitest";
import type { LaunchSpec, SessionState } from "@termdock/protocol";
import { FakeBackend } from "../backend/fake.js";
import { InMemorySessionRepository } from "../storage/session-repository.js";
import { SessionRegistry } from "./registry.js";
import type { SessionRegistryOptions } from "./registry.js";

const spec: LaunchSpec = { backend: "wsl", distro: "Ubuntu", cwd: "/home/user/project" };

function setup(options: Partial<SessionRegistryOptions> = {}, backend = new FakeBackend()) {
  const registry = new SessionRegistry({ backends: [backend], reattachDelaysMs: [0, 0, 0], ...options });
  const states: string[] = [];
  registry.onStateChange(({ from, to }) => states.push(`${from}->${to}`));
  return { registry, backend, states };
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const stateIs = (registry: SessionRegistry, id: string, state: SessionState) => () =>
  registry.get(id).state === state;

describe("SessionRegistry: lost backend client", () => {
  it("re-attaches a Running session and keeps state, views and writer", async () => {
    const { registry, backend, states } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    await registry.attachView(id, "view-a");
    await registry.attachView(id, "view-b");
    states.length = 0;

    backend.pty(id).loseClient();
    await waitFor(() => backend.attaches.length === 1, "re-attach");

    expect(registry.get(id)).toMatchObject({ state: "Running", writerViewId: "view-a" });
    expect(states).toEqual([]);
    registry.input(id, "view-a", "ls\r");
    expect(backend.pty(id).input).toBe("ls\r");
    expect(backend.allPtys(id)).toHaveLength(2);
    expect(backend.starts).toHaveLength(1);
  });

  it("retries a failing attach and keeps a Detached session Detached", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.failNextStart = new Error("attach failed once");

    backend.pty(id).loseClient();
    await waitFor(() => backend.allPtys(id).length === 2, "second attach");

    expect(backend.attaches).toHaveLength(2);
    expect(registry.get(id).state).toBe("Detached");
  });

  it("marks the session Interrupted when the backend session is gone", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });

    backend.pty(id).emitExit();
    await waitFor(stateIs(registry, id, "Interrupted"), "Interrupted");

    expect(backend.attaches).toEqual([]);
  });

  it("gives up after three attempts when every new client is lost right away", async () => {
    const { registry, backend } = setup();
    const { id } = await registry.create({ name: "shell", launch: spec });
    backend.onPty = (pty) => setTimeout(() => pty.loseClient(), 0);

    backend.pty(id).loseClient();
    await waitFor(stateIs(registry, id, "Interrupted"), "Interrupted");

    expect(backend.attaches).toHaveLength(3);
  });

  it("gives up after three failing existence checks", async () => {
    const backend = new (class extends FakeBackend {
      checks = 0;
      override async exists(): Promise<boolean> {
        this.checks += 1;
        throw new Error("wsl.exe timed out");
      }
    })();
    const { registry } = setup({}, backend);
    const { id } = await registry.create({ name: "shell", launch: spec });

    backend.pty(id).loseClient();
    await waitFor(stateIs(registry, id, "Interrupted"), "Interrupted");

    expect(backend.checks).toBe(3);
    expect(backend.attaches).toEqual([]);
  });

  it("rejects kill while re-attaching and settles Detached when the last view left meanwhile", async () => {
    let releaseExists: (value: boolean) => void = () => {};
    const backend = new (class extends FakeBackend {
      override exists(): Promise<boolean> {
        return new Promise((resolve) => (releaseExists = resolve));
      }
    })();
    const { registry } = setup({}, backend);
    const { id } = await registry.create({ name: "shell", launch: spec });
    await registry.attachView(id, "view-a");

    backend.pty(id).loseClient();
    await expect(registry.kill(id)).rejects.toMatchObject({ code: "invalid_state" });
    registry.detachView(id, "view-a");
    expect(registry.get(id).state).toBe("Running");
    releaseExists(true);
    await waitFor(stateIs(registry, id, "Detached"), "Detached");

    await registry.kill(id);
    expect(registry.get(id).state).toBe("Exited");
  });
});

describe("SessionRegistry: dispose", () => {
  it("releases PTYs without changing, saving or reporting states", async () => {
    const repository = new InMemorySessionRepository();
    const { registry, backend, states } = setup({ repository });
    const { id } = await registry.create({ name: "shell", launch: spec });
    await registry.attachView(id, "view-a");
    states.length = 0;

    registry.dispose();

    expect(backend.pty(id).disposed).toBe(true);
    expect(backend.kills).toEqual([]);
    expect(repository.list()[0]?.state).toBe("Running");
    expect(states).toEqual([]);
    await expect(registry.create({ name: "late", launch: spec })).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  it("cancels a running re-attach and releases a PTY that arrives afterwards", async () => {
    let releaseExists: (value: boolean) => void = () => {};
    const backend = new (class extends FakeBackend {
      override exists(): Promise<boolean> {
        return new Promise((resolve) => (releaseExists = resolve));
      }
    })();
    const repository = new InMemorySessionRepository();
    const { registry, states } = setup({ repository }, backend);
    const { id } = await registry.create({ name: "shell", launch: spec });
    states.length = 0;

    backend.pty(id).loseClient();
    registry.dispose();
    releaseExists(true);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(backend.attaches).toEqual([]);
    expect(states).toEqual([]);
    expect(repository.list()[0]?.state).toBe("Detached");
  });
});
