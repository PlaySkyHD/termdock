// Autostart of launch profiles after the reconcile (issue #61, spec launch-profiles).
import { describe, expect, it } from "vitest";
import type { LaunchSpec, SessionInfo, SessionState } from "@termdock/protocol";
import { FakeBackend } from "../backend/fake.js";
import { InMemoryProfileRepository } from "../storage/profile-repository.js";
import { InMemorySessionRepository } from "../storage/session-repository.js";
import { InMemoryWorkspaceRepository } from "../storage/workspace-repository.js";
import { ProfileService } from "../workspace/profile-service.js";
import { WorkspaceService } from "../workspace/service.js";
import { runAutostart } from "./autostart.js";
import type { AutostartOptions } from "./autostart.js";
import { SessionRegistry } from "./registry.js";

const wsl: LaunchSpec = { backend: "wsl", distro: "Ubuntu", cwd: "/home/dev", command: ["claude"] };

/** FakeBackend that counts `available()` calls and can hold them until the test releases them. */
class CountingBackend extends FakeBackend {
  availableCalls = 0;
  gate: Promise<void> | undefined;

  override async available(): Promise<boolean> {
    this.availableCalls += 1;
    await this.gate;
    return super.available();
  }
}

function setup(stored: SessionInfo[] = []) {
  const backend = new CountingBackend();
  const repository = new InMemorySessionRepository();
  for (const session of stored) repository.save(session);
  const registry = new SessionRegistry({ backends: [backend], repository });
  const workspaces = new WorkspaceService(new InMemoryWorkspaceRepository());
  const profiles = new ProfileService(new InMemoryProfileRepository(), workspaces);
  const reports: string[] = [];
  const created: SessionInfo[] = [];
  registry.onCreated(({ session }) => created.push(session));
  const options = (overrides: Partial<AutostartOptions> = {}): AutostartOptions => ({
    registry,
    profiles,
    settings: () => ({}),
    backends: [backend],
    report: (text) => void reports.push(text),
    ...overrides,
  });
  return { backend, repository, registry, workspaces, profiles, reports, created, options };
}

function storedSession(id: string, state: SessionState, profileId: string): SessionInfo {
  return {
    id,
    name: `old ${id}`,
    state,
    launch: wsl,
    size: { cols: 80, rows: 24 },
    loggingEnabled: true,
    profileId,
    createdAt: "2026-11-13T10:00:00.000Z",
    updatedAt: "2026-11-13T10:00:00.000Z",
  };
}

describe("runAutostart", () => {
  it("starts exactly the profiles marked autostart, with name, workspace, logging and launch of the profile", async () => {
    const t = setup();
    await t.registry.restore();
    const workspace = t.workspaces.createWorkspace({ name: "web" });
    const claude = t.profiles.create({
      name: "Claude",
      launch: wsl,
      autostart: true,
      loggingEnabled: false,
      workspaceId: workspace.id,
    });
    const codex = t.profiles.create({
      name: "Codex",
      launch: { ...wsl, command: ["codex"] },
      autostart: true,
    });
    t.profiles.create({ name: "Manual", launch: wsl });

    const result = await runAutostart(t.options());
    await result.started;

    const sessions = t.registry.list();
    expect(sessions).toHaveLength(2);
    expect(sessions).toEqual([
      expect.objectContaining({
        name: "Claude",
        profileId: claude.id,
        workspaceId: workspace.id,
        loggingEnabled: false,
        launch: wsl,
        state: "Detached",
      }),
      expect.objectContaining({
        name: "Codex",
        profileId: codex.id,
        launch: codex.launch,
        state: "Detached",
      }),
    ]);
    expect(sessions[1]).not.toHaveProperty("workspaceId");
    expect(t.created.map((session) => [session.profileId, session.state])).toEqual([
      [claude.id, "Starting"],
      [codex.id, "Starting"],
    ]);
    expect(result.sessions.map((session) => session.id)).toEqual(sessions.map((session) => session.id));
    expect(t.backend.starts).toHaveLength(2);
    expect(t.reports).toEqual([]);
  });

  it("registers the sessions before it resolves, without waiting for their start", async () => {
    const t = setup();
    await t.registry.restore();
    t.profiles.create({ name: "Claude", launch: wsl, autostart: true });

    const result = await runAutostart(t.options());

    expect(t.registry.list()).toEqual([expect.objectContaining({ name: "Claude", state: "Starting" })]);
    await result.started;
    expect(t.registry.list()[0]?.state).toBe("Detached");
  });

  it("resolves the default directory of the profile like session.create", async () => {
    const t = setup();
    await t.registry.restore();
    const workspace = t.workspaces.createWorkspace({ name: "web", defaultCwd: "/srv/web" });
    const project = t.workspaces.createProject({
      workspaceId: workspace.id,
      name: "api",
      path: "/home/dev/api",
      backend: "wsl",
    });
    t.profiles.create({
      name: "api",
      launch: { backend: "wsl", cwd: "~" },
      autostart: true,
      projectId: project.id,
    });
    t.profiles.create({ name: "plain", launch: { backend: "wsl", cwd: "~" }, autostart: true });

    await (
      await runAutostart(t.options({ settings: () => ({ defaultCwd: "/opt" }) }))
    ).started;

    expect(t.registry.list().map((session) => [session.name, session.launch.cwd])).toEqual([
      ["api", "/home/dev/api"],
      ["plain", "/opt"],
    ]);
  });

  it("does not start a profile whose session survived the reconcile", async () => {
    const t = setup();
    const profile = t.profiles.create({ name: "Claude", launch: wsl, autostart: true });
    t.repository.save(storedSession("alive", "Running", profile.id));
    t.backend.setExists("alive", true);
    await t.registry.restore();

    const result = await runAutostart(t.options());
    await result.started;

    expect(t.registry.list()).toEqual([expect.objectContaining({ id: "alive", state: "Detached" })]);
    expect(result.sessions).toEqual([]);
    expect(t.backend.starts).toEqual([]);
  });

  it("does not start a profile whose session is still Starting", async () => {
    const t = setup();
    await t.registry.restore();
    const profile = t.profiles.create({ name: "Claude", launch: wsl, autostart: true });
    let release: () => void = () => {};
    t.backend.resolveLaunch = async (spec) => {
      await new Promise<void>((resolve) => (release = resolve));
      return spec;
    };
    const starting = t.registry.create({ name: "manual", launch: wsl, profileId: profile.id });

    const result = await runAutostart(t.options());

    expect(result.sessions).toEqual([]);
    release();
    await starting;
    expect(t.registry.list()).toHaveLength(1);
  });

  it("gives a profile whose session is Interrupted, Exited or Archived a new one and keeps the old", async () => {
    const t = setup();
    const interrupted = t.profiles.create({ name: "a", launch: wsl, autostart: true });
    const exited = t.profiles.create({ name: "b", launch: wsl, autostart: true });
    const archived = t.profiles.create({ name: "c", launch: wsl, autostart: true });
    t.repository.save(storedSession("old-a", "Interrupted", interrupted.id));
    t.repository.save({ ...storedSession("old-b", "Exited", exited.id), lastExitCode: 0 });
    t.repository.save(storedSession("old-c", "Archived", archived.id));
    await t.registry.restore();

    const result = await runAutostart(t.options());
    await result.started;

    expect(result.sessions.map((session) => session.profileId)).toEqual([
      interrupted.id,
      exited.id,
      archived.id,
    ]);
    const byId = new Map(t.registry.list().map((session) => [session.id, session.state]));
    expect(byId.get("old-a")).toBe("Interrupted");
    expect(byId.get("old-b")).toBe("Exited");
    expect(byId.get("old-c")).toBe("Archived");
    expect(t.registry.list()).toHaveLength(6);
  });

  it("starts nothing and reports an unreachable backend once, without asking it again", async () => {
    const t = setup();
    await t.registry.restore();
    t.backend.isAvailable = false;
    t.profiles.create({ name: "a", launch: wsl, autostart: true });
    t.profiles.create({ name: "b", launch: wsl, autostart: true });

    const result = await runAutostart(t.options());
    await result.started;

    expect(t.registry.list()).toEqual([]);
    expect(t.backend.availableCalls).toBe(1);
    expect(t.backend.starts).toEqual([]);
    expect(result.backendUnavailable).toEqual(["wsl"]);
    expect(t.registry.backendUnavailable()).toEqual(["wsl"]);
    expect(t.reports).toHaveLength(1);
    expect(t.reports[0]).toContain("backend_unavailable: wsl");
  });

  it("neither asks nor reports again a backend the reconcile already found unreachable", async () => {
    const t = setup([storedSession("old", "Running", "nobody")]);
    t.backend.isAvailable = false;
    const restore = await t.registry.restore();
    const callsAfterRestore = t.backend.availableCalls;
    t.profiles.create({ name: "a", launch: wsl, autostart: true });

    const result = await runAutostart(t.options({ knownUnavailable: restore.backendUnavailable }));
    await result.started;

    expect(t.backend.availableCalls).toBe(callsAfterRestore);
    expect(t.registry.list()).toHaveLength(1);
    expect(t.registry.backendUnavailable()).toEqual(["wsl"]);
    expect(result.backendUnavailable).toEqual(["wsl"]);
    // The Core has already written the reconcile's backend_unavailable line.
    expect(t.reports).toEqual([]);
  });

  it("reports a profile whose backend is missing", async () => {
    const t = setup();
    await t.registry.restore();
    t.profiles.create({
      name: "win",
      launch: { backend: "windows", shell: "pwsh", cwd: "C:\\x" },
      autostart: true,
    });

    await (
      await runAutostart(t.options())
    ).started;

    expect(t.registry.list()).toEqual([]);
    expect(t.registry.backendUnavailable()).toEqual(["windows"]);
    expect(t.reports).toEqual([expect.stringContaining("backend_unavailable: windows")]);
  });

  it("marks a failed start Interrupted, reports it once and does not retry", async () => {
    const t = setup();
    await t.registry.restore();
    const profile = t.profiles.create({ name: "a", launch: wsl, autostart: true });
    t.backend.failNextStart = new Error("tmux failed");

    const result = await runAutostart(t.options());
    await result.started;

    expect(t.registry.list()).toEqual([
      expect.objectContaining({ profileId: profile.id, state: "Interrupted" }),
    ]);
    expect(t.backend.starts).toHaveLength(1);
    expect(t.reports).toHaveLength(1);
    expect(t.reports[0]).toContain(profile.id);
    expect(t.reports[0]).not.toContain("claude");
  });

  it("creates nothing when the core closes during the backend check", async () => {
    const t = setup();
    await t.registry.restore();
    t.profiles.create({ name: "a", launch: wsl, autostart: true });
    let release: () => void = () => {};
    t.backend.gate = new Promise((resolve) => (release = resolve));
    let closed = false;

    const running = runAutostart(t.options({ cancelled: () => closed }));
    closed = true;
    release();
    await (
      await running
    ).started;

    expect(t.registry.list()).toEqual([]);
    expect(t.reports).toEqual([]);
  });

  it("reports a failure to read the profiles and starts nothing", async () => {
    const t = setup();
    await t.registry.restore();
    const broken = new ProfileService(
      {
        list: () => {
          throw new Error("database locked");
        },
        save: () => {},
        delete: () => false,
      },
      t.workspaces,
    );

    const result = await runAutostart(t.options({ profiles: broken }));
    await result.started;

    expect(t.registry.list()).toEqual([]);
    expect(t.reports).toEqual([expect.stringContaining("database locked")]);
  });
});
