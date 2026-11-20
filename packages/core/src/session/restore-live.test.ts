// Reconcile with `listLive` (issue #134): one backend call for all stored sessions instead of `exists` per session.
import { describe, expect, it } from "vitest";
import type { LaunchSpec, SessionInfo } from "@termdock/protocol";
import { FakeBackend } from "../backend/fake.js";
import { InMemorySessionRepository } from "../storage/session-repository.js";
import { SessionRegistry } from "./registry.js";

const wsl: LaunchSpec = { backend: "wsl", distro: "Ubuntu", cwd: "/home/user/project" };
const windows: LaunchSpec = { backend: "windows", shell: "pwsh", cwd: "C:\\Projects\\x" };
const NOW = new Date("2026-11-20T08:00:00.000Z");

function stored(overrides: Partial<SessionInfo> & Pick<SessionInfo, "id" | "state">): SessionInfo {
  return {
    name: `session ${overrides.id}`,
    launch: wsl,
    size: { cols: 100, rows: 30 },
    loggingEnabled: true,
    createdAt: "2026-11-13T10:00:00.000Z",
    updatedAt: "2026-11-13T10:00:00.000Z",
    ...overrides,
  };
}

/** Distinct `createdAt`, so the repository lists them in the given order. */
function many(states: SessionInfo["state"][], launch: LaunchSpec = wsl): SessionInfo[] {
  return states.map((state, i) =>
    stored({ id: `s${i}`, state, launch, createdAt: `2026-11-13T10:${String(i).padStart(2, "0")}:00.000Z` }),
  );
}

function restoring(sessions: SessionInfo[], backends: FakeBackend[]) {
  const repository = new InMemorySessionRepository();
  for (const session of sessions) repository.save(session);
  const registry = new SessionRegistry({ backends, repository, now: () => NOW });
  return { registry, repository };
}

describe("SessionRegistry.restore with listLive (issue #134)", () => {
  it("asks listLive once for every live session: alive → Detached, missing → Interrupted, no exists call", async () => {
    const backend = new FakeBackend({ listLive: true });
    backend.setExists("s0", true);
    backend.setExists("s2", true);
    const sessions = many(["Running", "Detached", "Starting", "Exited", "Interrupted", "Archived"]);
    const { registry, repository } = restoring(sessions, [backend]);

    const result = await registry.restore();

    expect(backend.listLiveCalls).toEqual([["s0", "s1", "s2"]]);
    expect(backend.existsCalls).toEqual([]);
    expect(result).toEqual({
      sessions: [
        { sessionId: "s0", from: "Running", to: "Detached" },
        { sessionId: "s1", from: "Detached", to: "Interrupted" },
        { sessionId: "s2", from: "Starting", to: "Detached" },
      ],
      backendUnavailable: [],
      backendAvailable: ["wsl"],
    });
    expect(backend.attaches.map((call) => call.id)).toEqual(["s0", "s2"]);
    expect(backend.starts).toEqual([]);
    expect(repository.list().map((session) => session.state)).toEqual([
      "Detached",
      "Interrupted",
      "Detached",
      "Exited",
      "Interrupted",
      "Archived",
    ]);
  });

  it("falls back to exists per session when listLive answers undefined", async () => {
    const backend = new FakeBackend({ listLive: true });
    backend.listLiveUnknown = true;
    backend.setExists("s1", true);
    const { registry } = restoring(many(["Running", "Running"]), [backend]);

    const result = await registry.restore();

    expect(backend.listLiveCalls).toHaveLength(1);
    expect(backend.existsCalls).toEqual(["s0", "s1"]);
    expect(result.sessions.map((session) => session.to)).toEqual(["Interrupted", "Detached"]);
    expect(result.backendUnavailable).toEqual([]);
  });

  it("falls back to exists per session when listLive fails, and still reports a failing exists", async () => {
    const backend = new FakeBackend({ listLive: true });
    backend.failNextListLive = new Error("wsl.exe timed out");
    backend.failNextExists = new Error("wsl.exe timed out");
    backend.setExists("s1", true);
    const { registry } = restoring(many(["Running", "Running"]), [backend]);

    const result = await registry.restore();

    expect(backend.existsCalls).toEqual(["s0", "s1"]);
    expect(result.sessions.map((session) => session.to)).toEqual(["Interrupted", "Detached"]);
    expect(result.backendUnavailable).toEqual(["wsl"]);
  });

  it("does not ask listLive of an unreachable backend, nor for Windows or finished sessions", async () => {
    const offline = new FakeBackend({ listLive: true });
    offline.isAvailable = false;
    const windowsBackend = new FakeBackend({ kind: "windows", listLive: true });
    const sessions = [
      ...many(["Running"]),
      stored({ id: "w", state: "Running", launch: windows, createdAt: "2026-11-13T11:00:00.000Z" }),
    ];
    const { registry } = restoring(sessions, [offline, windowsBackend]);

    const result = await registry.restore();

    expect(offline.listLiveCalls).toEqual([]);
    expect(windowsBackend.listLiveCalls).toEqual([]);
    expect(result.sessions.map((session) => session.to)).toEqual(["Interrupted", "Interrupted"]);
    expect(result.backendUnavailable).toEqual(["wsl"]);
  });

  it("skips listLive when no stored session is live", async () => {
    const backend = new FakeBackend({ listLive: true });
    const { registry } = restoring(many(["Exited", "Archived"]), [backend]);

    await registry.restore();

    expect(backend.listLiveCalls).toEqual([]);
  });

  it("changes and saves nothing when the core ends during listLive", async () => {
    const backend = new FakeBackend({ listLive: true });
    backend.setExists("s0", true);
    const { registry, repository } = restoring(many(["Running"]), [backend]);
    backend.beforeListLive = () => registry.dispose();

    await registry.restore();

    expect(backend.attaches).toEqual([]);
    expect(repository.list()[0]?.state).toBe("Running");
  });

  it("a session listed as alive whose attach fails becomes Interrupted", async () => {
    const backend = new FakeBackend({ listLive: true });
    backend.setExists("s0", true);
    backend.failNextStart = new Error("attach failed");
    const { registry } = restoring(many(["Running"]), [backend]);

    const result = await registry.restore();

    expect(result.sessions).toEqual([{ sessionId: "s0", from: "Running", to: "Interrupted" }]);
  });
});
