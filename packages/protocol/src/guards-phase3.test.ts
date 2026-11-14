// Guards of the phase-3 messages (issue #55, openspec change phase-3-contracts).
import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "./frame.js";
import type { Frame } from "./frame.js";
import {
  parseEvent,
  parseRequest,
  parseResponse,
  validateLaunchProfile,
  validateProject,
  validateSettings,
  validateWorkspace,
} from "./guards.js";
import { METHODS, PHASE_3_METHODS } from "./messages.js";
import {
  DEFAULT_SETTINGS,
  MAX_PATH_LENGTH,
  MAX_PROJECTS_PER_WORKSPACE,
  MAX_WORKSPACE_BYTES,
  MAX_WORKSPACES,
} from "./model.js";

/** Goes through the real codec so tests see what a peer would see. */
function frame(header: unknown, payload?: Uint8Array): Frame {
  return new FrameDecoder().push(encodeFrame(header, payload))[0] as Frame;
}

function request(method: string, params: unknown, payload?: Uint8Array): Frame {
  return frame({ kind: "request", id: "r1", method, params }, payload);
}

function response(result: unknown): Frame {
  return frame({ kind: "response", id: "r1", result });
}

/** Message of the parse failure; fails the test when the parse succeeded. */
function rejected(result: { ok: boolean }): string {
  if (result.ok) throw new Error(`expected a parse failure, got ${JSON.stringify(result)}`);
  const failed = result as unknown as { error: { code: string; message: string } };
  expect(failed.error.code).toBe("bad_request");
  return failed.error.message;
}

function accepts(method: string, params: unknown): void {
  const parsed = parseRequest(request(method, params));
  expect(parsed.ok, `${method} ${JSON.stringify(params)}: ${JSON.stringify(parsed)}`).toBe(true);
  if (parsed.ok) expect(parsed.value.params).toEqual(params);
}

function rejects(method: string, params: unknown, field?: string): void {
  const message = rejected(parseRequest(request(method, params)));
  if (field !== undefined) expect(message).toContain(field);
}

const name128 = "n".repeat(128);
const project = { id: "p1", workspaceId: "w1", name: "termdock", path: "/home/dev/termdock", backend: "wsl" };
const workspace = { id: "w1", name: "TermDock", projects: [project], defaultCwd: "/home/dev" };

describe("workspace and project requests", () => {
  it("accepts valid params", () => {
    accepts("workspace.list", {});
    accepts("workspace.create", { name: "TermDock" });
    accepts("workspace.create", { name: name128, defaultCwd: "/home/dev" });
    accepts("workspace.update", { workspaceId: "w1", name: "Neu" });
    accepts("workspace.update", { workspaceId: "w1", defaultCwd: null });
    accepts("workspace.delete", { workspaceId: "w1" });
    accepts("project.create", { workspaceId: "w1", name: "api", path: "/home/dev/api", backend: "wsl" });
    accepts("project.create", {
      workspaceId: "w1",
      name: "api",
      path: "/home/dev/api",
      backend: "wsl",
      distro: "Ubuntu",
    });
    accepts("project.create", { workspaceId: "w1", name: "app", path: "C:\\src\\app", backend: "windows" });
    accepts("project.update", { projectId: "p1", path: "/srv/api" });
    accepts("project.update", { projectId: "p1", distro: null });
    accepts("project.update", { projectId: "p1", backend: "windows", distro: null });
    accepts("project.delete", { projectId: "p1" });
  });

  it("rejects names that are too long, empty or only spaces", () => {
    rejects("workspace.create", { name: "n".repeat(129) }, "params.name");
    rejects("workspace.create", { name: "" }, "params.name");
    rejects("workspace.create", { name: "   " }, "params.name");
    rejects("workspace.update", { workspaceId: "w1", name: "n".repeat(129) }, "params.name");
    rejects("project.create", { workspaceId: "w1", name: " ", path: "/a", backend: "wsl" }, "params.name");
  });

  it("rejects paths that are too long, empty or contain NUL", () => {
    accepts("workspace.create", { name: "w", defaultCwd: `/${"p".repeat(511)}` });
    rejects("workspace.create", { name: "w", defaultCwd: `/${"p".repeat(512)}` }, "params.defaultCwd");
    rejects("workspace.create", { name: "w", defaultCwd: "" }, "params.defaultCwd");
    rejects(
      "project.create",
      { workspaceId: "w1", name: "a", path: "/a\u0000b", backend: "wsl" },
      "params.path",
    );
    rejects("project.update", { projectId: "p1", path: 5 }, "params.path");
  });

  it("rejects missing fields, null for required fields and updates without a change", () => {
    rejects("workspace.create", {}, "params.name");
    rejects("workspace.update", { workspaceId: "w1" }, "params");
    rejects("workspace.update", { workspaceId: "w1", name: null }, "params.name");
    rejects("workspace.update", { name: "x" }, "params.workspaceId");
    rejects("workspace.delete", {}, "params.workspaceId");
    rejects("project.create", { workspaceId: "w1", name: "a", backend: "wsl" }, "params.path");
    rejects("project.create", { workspaceId: "w1", name: "a", path: "/a" }, "params.backend");
    rejects("project.create", { workspaceId: "w1", name: "a", path: "/a", backend: "mac" }, "params.backend");
    rejects("project.update", { projectId: "p1" }, "params");
    rejects("project.update", { projectId: "p1", backend: null }, "params.backend");
  });

  it("allows distro only for backend wsl", () => {
    rejects(
      "project.create",
      { workspaceId: "w1", name: "a", path: "C:\\a", backend: "windows", distro: "Ubuntu" },
      "params.distro",
    );
    rejects("project.update", { projectId: "p1", backend: "windows", distro: "Ubuntu" }, "params.distro");
  });

  it("rejects unknown fields and ids over 128 characters", () => {
    rejects("workspace.create", { name: "w", farbe: "blau" }, "farbe");
    rejects("workspace.list", { all: true }, "all");
    rejects("project.delete", { projectId: "p1", force: true }, "force");
    rejects("workspace.delete", { workspaceId: "w".repeat(129) }, "params.workspaceId");
  });

  it("rejects payload", () => {
    rejected(parseRequest(request("workspace.list", {}, Uint8Array.from([1]))));
  });
});

describe("workspace and project results", () => {
  it("parses lists and changed objects", () => {
    expect(parseResponse(response({ workspaces: [workspace] }), "workspace.list").ok).toBe(true);
    expect(parseResponse(response({ workspaces: [] }), "workspace.list").ok).toBe(true);
    expect(parseResponse(response({ workspace }), "workspace.create").ok).toBe(true);
    expect(
      parseResponse(response({ workspace: { ...workspace, projects: [] } }), "workspace.update").ok,
    ).toBe(true);
    expect(parseResponse(response({}), "workspace.delete").ok).toBe(true);
    expect(parseResponse(response({ project }), "project.create").ok).toBe(true);
    expect(parseResponse(response({ project: { ...project, distro: "Ubuntu" } }), "project.update").ok).toBe(
      true,
    );
    expect(parseResponse(response({}), "project.delete").ok).toBe(true);
  });

  it("accepts fields a newer core adds", () => {
    expect(
      parseResponse(response({ workspace: { ...workspace, color: "blue" } }), "workspace.create").ok,
    ).toBe(true);
  });

  it("rejects invalid workspaces and projects", () => {
    const list = (workspaces: unknown) => parseResponse(response({ workspaces }), "workspace.list");
    expect(rejected(list([{ ...workspace, projects: undefined }]))).toContain(
      "result.workspaces[0].projects",
    );
    expect(rejected(list([{ ...workspace, projects: [{ ...project, path: undefined }] }]))).toContain(
      "result.workspaces[0].projects[0].path",
    );
    expect(
      rejected(list([{ ...workspace, projects: [{ ...project, backend: "windows", distro: "Ubuntu" }] }])),
    ).toContain("distro");
    expect(rejected(parseResponse(response({}), "workspace.create"))).toContain("result.workspace");
  });

  it("rejects lists over the limits", () => {
    const many = Array.from({ length: 65 }, (_, i) => ({ ...workspace, id: `w${i}`, projects: [] }));
    expect(rejected(parseResponse(response({ workspaces: many }), "workspace.list"))).toContain("64");
    const projects = Array.from({ length: 17 }, (_, i) => ({ ...project, id: `p${i}` }));
    expect(
      rejected(parseResponse(response({ workspace: { ...workspace, projects } }), "workspace.create")),
    ).toContain("16");
  });
});

const launch = { backend: "wsl", cwd: "/home/dev", command: ["claude"] };
const profile = { id: "pr1", name: "Claude", launch, autostart: false, loggingEnabled: true };

describe("profile messages", () => {
  it("accepts valid params", () => {
    accepts("profile.list", {});
    accepts("profile.create", { name: "Claude", launch });
    accepts("profile.create", {
      name: "Watch",
      workspaceId: "w1",
      projectId: "p1",
      launch: {
        backend: "wsl",
        cwd: "/home/dev/api",
        command: ["dotnet", "watch"],
        env: { DOTNET_ENV: "dev" },
      },
      autostart: true,
      loggingEnabled: false,
    });
    accepts("profile.update", { profileId: "pr1", autostart: true });
    accepts("profile.update", { profileId: "pr1", workspaceId: null, projectId: null });
    accepts("profile.update", {
      profileId: "pr1",
      launch: { backend: "windows", cwd: "C:\\", shell: "pwsh" },
    });
    accepts("profile.delete", { profileId: "pr1" });
  });

  it("rejects invalid params", () => {
    rejects("profile.create", { name: "Claude" }, "params.launch");
    rejects("profile.create", { name: "", launch }, "params.name");
    rejects(
      "profile.create",
      { name: "x", launch: { ...launch, command: "claude --resume" } },
      "params.launch.command",
    );
    rejects("profile.create", { name: "x", launch, autostart: "yes" }, "params.autostart");
    rejects("profile.create", { name: "x", launch, secret: "t" }, "secret");
    rejects("profile.update", { profileId: "pr1" }, "params");
    rejects("profile.update", { profileId: "pr1", name: null }, "params.name");
    rejects("profile.update", { profileId: "pr1", launch: null }, "params.launch");
    rejects("profile.delete", {}, "params.profileId");
  });

  it("rejects a profile over 8 KiB", () => {
    const env = (bytes: number) => ({ A: "x".repeat(bytes) });
    accepts("profile.create", { name: "x", launch: { ...launch, env: env(7000) } });
    rejects("profile.create", { name: "x", launch: { ...launch, env: env(8192) } }, "8192");
    rejects("profile.update", { profileId: "pr1", launch: { ...launch, env: env(8192) } }, "8192");
    expect(
      rejected(
        parseResponse(
          response({ profile: { ...profile, launch: { ...launch, env: env(8192) } } }),
          "profile.create",
        ),
      ),
    ).toContain("result.profile");
  });

  it("parses results and rejects invalid profiles", () => {
    expect(parseResponse(response({ profiles: [profile] }), "profile.list").ok).toBe(true);
    expect(parseResponse(response({ profile: { ...profile, workspaceId: "w1" } }), "profile.update").ok).toBe(
      true,
    );
    expect(parseResponse(response({}), "profile.delete").ok).toBe(true);
    expect(
      rejected(parseResponse(response({ profile: { ...profile, autostart: undefined } }), "profile.create")),
    ).toContain("result.profile.autostart");
    const many = Array.from({ length: 65 }, (_, i) => ({ ...profile, id: `pr${i}` }));
    expect(rejected(parseResponse(response({ profiles: many }), "profile.list"))).toContain("64");
  });
});

const sessionInfo = {
  id: "s1",
  name: "Build",
  state: "Running",
  launch: { backend: "wsl", cwd: "/home/dev" },
  size: { cols: 80, rows: 24 },
  loggingEnabled: true,
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:00.000Z",
};

describe("session messages of phase 3", () => {
  it("accepts update, archive and delete", () => {
    accepts("session.update", { sessionId: "s1", name: "Neu" });
    accepts("session.update", { sessionId: "s1", workspaceId: null });
    accepts("session.update", { sessionId: "s1", workspaceId: "w1", loggingEnabled: false });
    accepts("session.archive", { sessionId: "s1" });
    accepts("session.delete", { sessionId: "s1" });
  });

  it("rejects an update without change, bad names and unknown fields", () => {
    rejects("session.update", { sessionId: "s1" }, "params");
    rejects("session.update", { sessionId: "s1", name: "n".repeat(129) }, "params.name");
    rejects("session.update", { sessionId: "s1", name: null }, "params.name");
    rejects("session.update", { sessionId: "s1", loggingEnabled: null }, "params.loggingEnabled");
    rejects("session.update", { sessionId: "s1", workspaceId: "" }, "params.workspaceId");
    rejects("session.update", { sessionId: "s1", state: "Exited" }, "state");
    rejects("session.archive", {}, "params.sessionId");
    rejects("session.delete", { sessionId: "s1", force: true }, "force");
  });

  it("parses the results", () => {
    expect(parseResponse(response({ session: sessionInfo }), "session.update").ok).toBe(true);
    expect(parseResponse(response({}), "session.archive").ok).toBe(true);
    expect(parseResponse(response({}), "session.delete").ok).toBe(true);
    expect(rejected(parseResponse(response({}), "session.update"))).toContain("result.session");
  });

  it("allows session.create without launch only with a profile", () => {
    accepts("session.create", { name: "Claude", profileId: "pr1" });
    accepts("session.create", { name: "Claude", profileId: "pr1", launch });
    rejects("session.create", { name: "Claude" }, "params.launch");
    rejects(
      "session.create",
      { name: "Claude", profileId: "pr1", launch: { backend: "mac", cwd: "/" } },
      "params.launch.backend",
    );
  });
});

const settings = {
  historyLimitBytes: 10 * 1024 * 1024,
  historyEnabledByDefault: true,
  confirmQuitWhileRunning: true,
};

describe("settings messages", () => {
  it("accepts get and partial set", () => {
    accepts("settings.get", {});
    accepts("settings.set", { settings: { historyLimitBytes: 65536, defaultDistro: null } });
    accepts("settings.set", { settings: { historyLimitBytes: 1024 * 1024 * 1024 } });
    accepts("settings.set", {
      settings: {
        defaultShell: "pwsh",
        defaultCwd: "/home/dev",
        confirmQuitWhileRunning: false,
        quitAction: "stopSessions",
      },
    });
    accepts("settings.set", { settings: { defaultShell: null, defaultCwd: null, quitAction: null } });
  });

  it("rejects values out of range, null for required keys and unknown keys", () => {
    rejects("settings.set", { settings: { historyLimitBytes: 65535 } }, "params.settings.historyLimitBytes");
    rejects(
      "settings.set",
      { settings: { historyLimitBytes: 1024 * 1024 * 1024 + 1 } },
      "params.settings.historyLimitBytes",
    );
    rejects(
      "settings.set",
      { settings: { historyLimitBytes: 100000.5 } },
      "params.settings.historyLimitBytes",
    );
    rejects("settings.set", { settings: { historyLimitBytes: null } }, "params.settings.historyLimitBytes");
    rejects(
      "settings.set",
      { settings: { historyEnabledByDefault: null } },
      "params.settings.historyEnabledByDefault",
    );
    rejects("settings.set", { settings: { defaultShell: "bash" } }, "params.settings.defaultShell");
    rejects("settings.set", { settings: { quitAction: "ask" } }, "params.settings.quitAction");
    rejects("settings.set", { settings: { farbe: "blau" } }, "farbe");
    rejects("settings.set", { settings: {} }, "params.settings");
    rejects("settings.set", {}, "params.settings");
    rejects("settings.get", { key: "x" }, "key");
  });

  it("parses settings results with defaults and optional keys", () => {
    expect(parseResponse(response({ settings }), "settings.get").ok).toBe(true);
    expect(
      parseResponse(
        response({
          settings: { ...settings, defaultDistro: "Ubuntu", defaultShell: "cmd", quitAction: "keepSessions" },
        }),
        "settings.set",
      ).ok,
    ).toBe(true);
    expect(
      rejected(
        parseResponse(
          response({ settings: { ...settings, confirmQuitWhileRunning: undefined } }),
          "settings.get",
        ),
      ),
    ).toContain("result.settings.confirmQuitWhileRunning");
  });
});

const hit = { sessionId: "s1", timestamp: 1763114400000, line: "error: build failed", offset: 0 };

describe("history.search", () => {
  it("accepts queries at the limits", () => {
    accepts("history.search", { query: "e" });
    accepts("history.search", { query: "q".repeat(256), limit: 200 });
    accepts("history.search", { query: "error", sessionIds: ["s1", "s2"], limit: 1 });
    accepts("history.search", { query: "error", sessionIds: Array.from({ length: 256 }, (_, i) => `s${i}`) });
  });

  it("rejects queries out of the limits", () => {
    rejects("history.search", { query: "q".repeat(257) }, "params.query");
    rejects("history.search", { query: "" }, "params.query");
    rejects("history.search", {}, "params.query");
    rejects("history.search", { query: "e", limit: 0 }, "params.limit");
    rejects("history.search", { query: "e", limit: 201 }, "params.limit");
    rejects("history.search", { query: "e", limit: 2.5 }, "params.limit");
    rejects("history.search", { query: "e", sessionIds: [] }, "params.sessionIds");
    rejects(
      "history.search",
      { query: "e", sessionIds: Array.from({ length: 257 }, (_, i) => `s${i}`) },
      "params.sessionIds",
    );
    rejects("history.search", { query: "e", sessionIds: [5] }, "params.sessionIds[0]");
    rejects("history.search", { query: "e", regex: true }, "regex");
  });

  it("parses hits and truncated", () => {
    const search = (result: unknown) => parseResponse(response(result), "history.search");
    expect(search({ hits: [hit], truncated: true }).ok).toBe(true);
    expect(search({ hits: [], truncated: false }).ok).toBe(true);
    expect(rejected(search({ hits: [hit] }))).toContain("result.truncated");
    expect(rejected(search({ hits: [{ ...hit, offset: -1 }], truncated: false }))).toContain(
      "result.hits[0].offset",
    );
    expect(rejected(search({ hits: [{ ...hit, timestamp: "now" }], truncated: false }))).toContain(
      "result.hits[0].timestamp",
    );
    expect(rejected(search({ hits: [{ ...hit, line: "l".repeat(513) }], truncated: false }))).toContain(
      "result.hits[0].line",
    );
    expect(rejected(search({ hits: Array.from({ length: 201 }, () => hit), truncated: true }))).toContain(
      "200",
    );
  });
});

describe("phase-3 events", () => {
  const event = (name: string, data: unknown, payload?: Uint8Array) =>
    parseEvent(frame({ kind: "event", event: name, data }, payload));

  it("parses the events with valid data", () => {
    const valid: [string, unknown][] = [
      ["session.updated", { session: sessionInfo }],
      ["session.removed", { sessionId: "s1" }],
      ["workspace.changed", { workspaces: [workspace] }],
      ["workspace.changed", { workspaces: [] }],
      ["profile.changed", { profiles: [profile] }],
      ["settings.changed", { settings }],
    ];
    for (const [name, data] of valid) {
      const parsed = event(name, data);
      expect(parsed.ok, `${name}: ${JSON.stringify(parsed)}`).toBe(true);
      if (parsed.ok) expect(parsed.value.data).toEqual(data);
    }
  });

  it("rejects missing fields, invalid entries, lists over the limit and payload", () => {
    expect(rejected(event("session.updated", {}))).toContain("data.session");
    expect(rejected(event("session.updated", { session: { ...sessionInfo, state: "Weg" } }))).toContain(
      "data.session.state",
    );
    expect(rejected(event("session.removed", {}))).toContain("data.sessionId");
    expect(rejected(event("workspace.changed", { workspaces: [{ ...workspace, name: "" }] }))).toContain(
      "data.workspaces[0].name",
    );
    const many = Array.from({ length: 65 }, (_, i) => ({ ...workspace, id: `w${i}`, projects: [] }));
    expect(rejected(event("workspace.changed", { workspaces: many }))).toContain("64");
    expect(rejected(event("profile.changed", { profiles: [{ ...profile, launch: undefined }] }))).toContain(
      "data.profiles[0].launch",
    );
    expect(
      rejected(event("settings.changed", { settings: { ...settings, historyLimitBytes: 1 } })),
    ).toContain("data.settings.historyLimitBytes");
    expect(rejected(event("session.removed", { sessionId: "s1" }, Uint8Array.from([1])))).toContain(
      "payload",
    );
  });
});

describe("review findings of the phase-3 guards", () => {
  it("limits cwd and distro of a profile's launch spec like other paths and names", () => {
    rejects(
      "profile.create",
      { name: "x", launch: { ...launch, cwd: `/${"p".repeat(512)}` } },
      "params.launch.cwd",
    );
    rejects(
      "profile.create",
      { name: "x", launch: { ...launch, distro: "d".repeat(129) } },
      "params.launch.distro",
    );
    rejects(
      "profile.update",
      { profileId: "pr1", launch: { ...launch, cwd: "/a\u0000" } },
      "params.launch.cwd",
    );
    expect(
      rejected(
        parseResponse(
          response({ profiles: [{ ...profile, launch: { ...launch, distro: " " } }] }),
          "profile.list",
        ),
      ),
    ).toContain("result.profiles[0].launch.distro");
  });

  it("rejects a distro of only spaces", () => {
    rejects("settings.set", { settings: { defaultDistro: "   " } }, "params.settings.defaultDistro");
    rejects(
      "project.create",
      { workspaceId: "w1", name: "a", path: "/a", backend: "wsl", distro: " " },
      "params.distro",
    );
  });

  it("rejects a hit whose offset lies outside its line", () => {
    const search = (offset: number) =>
      parseResponse(
        response({ hits: [{ ...hit, line: "abc", offset }], truncated: false }),
        "history.search",
      );
    expect(search(3).ok).toBe(true);
    expect(rejected(search(4))).toContain("result.hits[0].offset");
  });

  it("validates merged objects before the core stores them", () => {
    // A request under 8 KiB can still give a stored profile over it (id, defaults, several updates).
    const big = { ...profile, launch: { ...launch, env: { A: "x".repeat(8100) } } };
    expect(validateLaunchProfile(profile)).toEqual({ ok: true, value: profile });
    expect(rejected(validateLaunchProfile(big))).toContain("profile");
    // project.update { distro } alone passes the request guard; the merged project must not.
    expect(validateProject(project).ok).toBe(true);
    expect(rejected(validateProject({ ...project, backend: "windows", distro: "Ubuntu" }))).toContain(
      "project.distro",
    );
    expect(validateWorkspace(workspace).ok).toBe(true);
    expect(rejected(validateWorkspace({ ...workspace, name: "" }))).toContain("workspace.name");
    expect(validateSettings(DEFAULT_SETTINGS).ok).toBe(true);
    expect(rejected(validateSettings({ ...DEFAULT_SETTINGS, historyLimitBytes: 0 }))).toContain(
      "settings.historyLimitBytes",
    );
  });
});

describe("findings of the PR #79 review", () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  /** A workspace with 16 projects whose paths are filled with a character JSON escapes to 6 bytes. */
  function fullWorkspace(id: string): Record<string, unknown> {
    const build = (k: number) => ({
      id,
      name: "\u0001".repeat(128),
      projects: Array.from({ length: MAX_PROJECTS_PER_WORKSPACE }, (_, i) => ({
        id: `${id}-p${i}`,
        workspaceId: id,
        name: "n",
        path: `/${"\u0001".repeat(k)}`,
        backend: "wsl",
      })),
    });
    const perChar = 6 * MAX_PROJECTS_PER_WORKSPACE;
    const k = Math.min(MAX_PATH_LENGTH - 1, Math.floor((MAX_WORKSPACE_BYTES - bytes(build(0))) / perChar));
    return build(k);
  }

  it("keeps a list of 64 workspaces at their byte limit below the header limit", () => {
    const one = fullWorkspace("w0");
    expect(validateWorkspace(one).ok).toBe(true);
    expect(bytes(one)).toBeGreaterThan(MAX_WORKSPACE_BYTES - 6 * MAX_PROJECTS_PER_WORKSPACE);
    const workspaces = Array.from({ length: MAX_WORKSPACES }, (_, i) => fullWorkspace(`w${i}`));
    const header = { kind: "event", event: "workspace.changed", data: { workspaces } };
    expect(() => encodeFrame(header)).not.toThrow();
    expect(parseEvent(frame(header)).ok).toBe(true);
    expect(parseResponse(response({ workspaces }), "workspace.list").ok).toBe(true);
  });

  it("rejects a workspace over its byte limit", () => {
    const over = { ...fullWorkspace("w0"), defaultCwd: `/${"\u0001".repeat(200)}` };
    expect(bytes(over)).toBeGreaterThan(MAX_WORKSPACE_BYTES);
    expect(rejected(validateWorkspace(over))).toContain(`${MAX_WORKSPACE_BYTES}`);
    expect(rejected(parseResponse(response({ workspaces: [over] }), "workspace.list"))).toContain(
      "result.workspaces[0]",
    );
  });

  it("requires distro: null when project.update switches to backend windows", () => {
    rejects("project.update", { projectId: "p1", backend: "windows" }, "params.distro");
    accepts("project.update", { projectId: "p1", backend: "windows", distro: null });
    accepts("project.update", { projectId: "p1", backend: "wsl" });
  });

  it("rejects projects of another workspace and duplicate project ids", () => {
    expect(
      rejected(validateWorkspace({ ...workspace, projects: [{ ...project, workspaceId: "w2" }] })),
    ).toContain("workspace.projects[0].workspaceId");
    expect(rejected(validateWorkspace({ ...workspace, projects: [project, { ...project }] }))).toContain(
      "workspace.projects[1].id",
    );
  });
});

describe("shared phase-3 constants", () => {
  it("default to 10 MiB history, history on and asking before quit", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      historyLimitBytes: 10485760,
      historyEnabledByDefault: true,
      confirmQuitWhileRunning: true,
    });
    expect(parseResponse(response({ settings: DEFAULT_SETTINGS }), "settings.get").ok).toBe(true);
  });

  it("list every phase-3 method as a known method without payload", () => {
    expect([...PHASE_3_METHODS].sort()).toEqual([
      "history.search",
      "profile.create",
      "profile.delete",
      "profile.list",
      "profile.update",
      "project.create",
      "project.delete",
      "project.update",
      "session.archive",
      "session.delete",
      "session.update",
      "settings.get",
      "settings.set",
      "workspace.create",
      "workspace.delete",
      "workspace.list",
      "workspace.update",
    ]);
    for (const method of PHASE_3_METHODS) expect(METHODS).toContain(method);
  });
});
