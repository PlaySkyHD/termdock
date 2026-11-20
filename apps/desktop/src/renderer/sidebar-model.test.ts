import type { Project, SessionInfo, SessionState, Workspace } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_TARGET,
  buildSections,
  canDelete,
  canDrop,
  confirmArchive,
  confirmDeleteWorkspace,
  isDraggable,
  focusReady,
  parseTarget,
  projectFocus,
  openModeOf,
  projectMenu,
  projectSessionParams,
  SIDEBAR_FOCUS,
  sessionFocus,
  workspaceFocus,
  sessionMenu,
  sessionPayload,
  UNGROUPED_TARGET,
  workspaceMenu,
  workspaceTarget,
} from "./sidebar-model.js";

function session(id: string, patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    name: `Session ${id}`,
    state: "Detached",
    launch: { backend: "wsl", cwd: "~" },
    size: { cols: 80, rows: 24 },
    loggingEnabled: false,
    createdAt: "2026-11-14T10:00:00Z",
    updatedAt: "2026-11-14T10:00:00Z",
    ...patch,
  };
}

const web: Workspace = { id: "w1", name: "Web", projects: [] };
const data: Workspace = { id: "w2", name: "Daten", projects: [] };
const workspaces = [web, data];
const ids = (list: readonly SessionInfo[]): string[] => list.map((s) => s.id);

describe("buildSections", () => {
  it("keeps the workspaces in the order of the core, each with its live sessions", () => {
    const sections = buildSections(
      [
        session("a", { workspaceId: "w2" }),
        session("b", { workspaceId: "w1" }),
        session("c", { workspaceId: "w2" }),
      ],
      workspaces,
    );

    expect(sections.workspaces.map((s) => [s.workspace.name, ids(s.sessions)])).toEqual([
      ["Web", ["b"]],
      ["Daten", ["a", "c"]],
    ]);
  });

  it("shows a workspace without sessions", () => {
    expect(buildSections([], [web]).workspaces).toEqual([{ workspace: web, sessions: [] }]);
  });

  it("[V1-12] puts sessions without workspace under the ungrouped section", () => {
    const sections = buildSections([session("a"), session("b", { workspaceId: "w1" })], workspaces);
    expect(ids(sections.ungrouped)).toEqual(["a"]);
  });

  it("does not lose a session whose workspace the window does not know (yet)", () => {
    const sections = buildSections([session("a", { workspaceId: "gone" })], workspaces);
    expect(ids(sections.ungrouped)).toEqual(["a"]);
  });

  it("collects archived sessions in the archive only, whatever their workspace", () => {
    const sections = buildSections(
      [
        session("a", { state: "Archived", workspaceId: "w1" }),
        session("b", { state: "Archived" }),
        session("c"),
      ],
      workspaces,
    );

    expect(ids(sections.archived)).toEqual(["a", "b"]);
    expect(ids(sections.ungrouped)).toEqual(["c"]);
    expect(sections.workspaces.every((s) => s.sessions.length === 0)).toBe(true);
  });
});

describe("drop targets", () => {
  it("names and parses the targets of workspaces, the ungrouped section and the archive", () => {
    expect(parseTarget(workspaceTarget("w1"))).toEqual({ kind: "move", workspaceId: "w1" });
    expect(parseTarget(UNGROUPED_TARGET)).toEqual({ kind: "move", workspaceId: null });
    expect(parseTarget(ARCHIVE_TARGET)).toEqual({ kind: "archive" });
  });

  it.each(["", "workspace:", "elsewhere", "tab:1"])("knows no target %j", (id) => {
    expect(parseTarget(id)).toBeUndefined();
  });

  it("describes the session being dragged", () => {
    expect(sessionPayload(session("a", { name: "Build" }))).toEqual({
      kind: "session",
      id: "a",
      label: "Build",
    });
  });

  it("lets a session go to another workspace, not to its own", () => {
    const inWeb = session("a", { workspaceId: "w1" });

    expect(canDrop(inWeb, { kind: "move", workspaceId: "w2" }, workspaces)).toBe(true);
    expect(canDrop(inWeb, { kind: "move", workspaceId: "w1" }, workspaces)).toBe(false);
  });

  it("lets a grouped session leave its group, not an ungrouped one", () => {
    expect(
      canDrop(session("a", { workspaceId: "w1" }), { kind: "move", workspaceId: null }, workspaces),
    ).toBe(true);
    expect(canDrop(session("a"), { kind: "move", workspaceId: null }, workspaces)).toBe(false);
  });

  it("refuses a workspace that is unknown to the window", () => {
    expect(canDrop(session("a"), { kind: "move", workspaceId: "gone" }, workspaces)).toBe(false);
  });

  it("lets every session that can be archived go to the archive, not a starting one", () => {
    const states: SessionState[] = ["Running", "Detached", "Exited", "Interrupted"];
    for (const state of states)
      expect(canDrop(session("a", { state }), { kind: "archive" }, workspaces)).toBe(true);
    expect(canDrop(session("a", { state: "Starting" }), { kind: "archive" }, workspaces)).toBe(false);
  });

  it("disables Archivieren in the menu of a starting session, with a reason, and keeps its moves", () => {
    const entries = sessionMenu(session("a", { state: "Starting" }), workspaces);
    const archive = entries.find((e) => e.key === "archive");

    expect(archive).toMatchObject({ disabled: true });
    expect(archive?.hint).toBeTruthy();
    expect(entries.some((e) => e.key === "move:w1")).toBe(true);
    const running = sessionMenu(session("a", { state: "Running" }), workspaces).find(
      (e) => e.key === "archive",
    );
    expect(running?.disabled).toBeUndefined();
  });

  it("lets an archived session go nowhere and keeps it from being dragged", () => {
    const archived = session("a", { state: "Archived", workspaceId: "w1" });

    expect(canDrop(archived, { kind: "archive" }, workspaces)).toBe(false);
    expect(canDrop(archived, { kind: "move", workspaceId: "w2" }, workspaces)).toBe(false);
    expect(canDrop(archived, { kind: "move", workspaceId: null }, workspaces)).toBe(false);
    expect(isDraggable(archived)).toBe(false);
    expect(isDraggable(session("b"))).toBe(true);
  });
});

describe("canDelete", () => {
  it.each<[SessionState, boolean]>([
    ["Starting", false],
    ["Running", false],
    ["Detached", false],
    ["Exited", true],
    ["Interrupted", true],
    ["Archived", true],
  ])("%s: %s", (state, expected) => {
    expect(canDelete(session("a", { state }))).toBe(expected);
  });
});

describe("sessionMenu", () => {
  const keys = (entries: ReturnType<typeof sessionMenu>): string[] => entries.map((e) => e.key);

  it("offers the same moves as drag and drop, for every workspace but the own one, and the archive", () => {
    const entries = sessionMenu(session("a", { workspaceId: "w1" }), workspaces);

    expect(keys(entries)).toEqual(["open", "rename", "move:w2", "move:", "archive", "delete"]);
    expect(entries.find((e) => e.key === "move:w2")).toMatchObject({
      label: "Verschieben nach Daten",
      action: { kind: "move", workspaceId: "w2" },
    });
    expect(entries.find((e) => e.key === "move:")).toMatchObject({
      label: "Verschieben nach Ohne Gruppe",
      action: { kind: "move", workspaceId: null },
    });
  });

  it("offers opening in the zones of the active pane after Öffnen, disabled ones with their hint (#67)", () => {
    const entries = sessionMenu(session("a"), workspaces, [
      { key: "place:left", label: "Links vom aktiven Pane öffnen", action: "left" },
      {
        key: "place:center",
        label: "Im aktiven Pane öffnen",
        action: "center",
        disabled: true,
        hint: "schon",
      },
    ]);

    expect(keys(entries).slice(0, 4)).toEqual(["open", "place:left", "place:center", "rename"]);
    expect(entries[1]).toMatchObject({ action: { kind: "place", zone: "left" } });
    expect(entries[2]).toMatchObject({
      action: { kind: "place", zone: "center" },
      disabled: true,
      hint: "schon",
    });
    expect(entries[3]?.separator).toBe(true);
  });

  it("offers no zones for an archived session, which cannot be dragged onto a pane either", () => {
    const place = { key: "place:center", label: "Im aktiven Pane öffnen", action: "center" as const };
    expect(keys(sessionMenu(session("a", { state: "Archived" }), workspaces, [place]))).not.toContain(
      "place:center",
    );
  });

  it("offers only the workspaces for an ungrouped session", () => {
    expect(keys(sessionMenu(session("a"), workspaces))).toEqual([
      "open",
      "rename",
      "move:w1",
      "move:w2",
      "archive",
      "delete",
    ]);
  });

  it("has exactly the moves canDrop allows", () => {
    for (const patch of [{}, { workspaceId: "w1" }, { workspaceId: "w2" }, { workspaceId: "gone" }]) {
      const current = session("a", patch);
      const fromMenu = sessionMenu(current, workspaces)
        .filter((e) => e.action.kind === "move")
        .map((e) => (e.action as { workspaceId: string | null }).workspaceId);
      const fromRules = [...workspaces.map((w) => w.id), null].filter((workspaceId) =>
        canDrop(current, { kind: "move", workspaceId }, workspaces),
      );
      expect(fromMenu).toEqual(fromRules);
    }
  });

  it("disables Löschen with a reason for a running session and enables it for ended ones", () => {
    const running = sessionMenu(session("a", { state: "Running" }), workspaces).find(
      (e) => e.key === "delete",
    );
    expect(running).toMatchObject({ disabled: true, danger: true });
    expect(running?.hint).toBeTruthy();

    for (const state of ["Exited", "Interrupted"] as const) {
      const entry = sessionMenu(session("a", { state }), workspaces).find((e) => e.key === "delete");
      expect(entry?.disabled).toBeUndefined();
    }
  });

  it("offers an archived session only Öffnen, Umbenennen and Löschen", () => {
    expect(keys(sessionMenu(session("a", { state: "Archived" }), workspaces))).toEqual([
      "open",
      "rename",
      "delete",
    ]);
  });
});

describe("focus plans", () => {
  it("names the row, the workspace button and the project row by id", () => {
    expect(sessionFocus("s1").selector).toBe('[data-row-session-id="s1"]');
    expect(workspaceFocus("w1").selector).toBe('[data-workspace-id="w1"] [data-action="workspace-menu"]');
    expect(projectFocus("p1").selector).toBe('[data-project-id="p1"]');
  });

  it("quotes an id, so it cannot leave the attribute selector", () => {
    expect(sessionFocus('x"] , body [a="').selector).toBe('[data-row-session-id="x\\"] , body [a=\\""]');
  });

  it("is ready at once without a wait", () => {
    expect(focusReady(sessionFocus("s1"), [])).toBe(true);
    expect(focusReady(SIDEBAR_FOCUS, [])).toBe(true);
  });

  it("waits for a moved session to arrive in its new group, ungrouped included", () => {
    const toWeb = sessionFocus("a", { sessionId: "a", workspaceId: "w1" });
    expect(focusReady(toWeb, [session("a")])).toBe(false);
    expect(focusReady(toWeb, [session("a", { workspaceId: "w1" })])).toBe(true);

    const ungroup = sessionFocus("a", { sessionId: "a", workspaceId: null });
    expect(focusReady(ungroup, [session("a", { workspaceId: "w1" })])).toBe(false);
    expect(focusReady(ungroup, [session("a")])).toBe(true);
  });

  it("waits for an archived session to show up in the archive (#97)", () => {
    const toArchive = sessionFocus("a", { sessionId: "a", archived: true });
    expect(focusReady(toArchive, [session("a")])).toBe(false);
    expect(focusReady(toArchive, [session("a", { state: "Archived" })])).toBe(true);
    expect(focusReady(toArchive, [])).toBe(true);
  });

  it("does not wait for a session that is gone", () => {
    expect(focusReady(sessionFocus("a", { sessionId: "a", workspaceId: "w1" }), [])).toBe(true);
  });
});

describe("workspace and project menus", () => {
  it("lists rename, add project and delete for a workspace", () => {
    expect(workspaceMenu().map((e) => e.key)).toEqual(["rename", "addProject", "delete"]);
  });

  it("lists a new session first, then rename and delete for a project (#104)", () => {
    expect(projectMenu().map((e) => e.key)).toEqual(["start", "rename", "delete"]);
    expect(projectMenu()[0]).toMatchObject({ label: "Neue Session hier", action: { kind: "start" } });
  });
});

describe("openModeOf (#104)", () => {
  it("maps Ctrl to a new tab, Shift to a split, and a plain click to the tab; Ctrl wins", () => {
    expect(openModeOf({ ctrlKey: false, shiftKey: false })).toBe("tab");
    expect(openModeOf({ ctrlKey: true, shiftKey: false })).toBe("newTab");
    expect(openModeOf({ ctrlKey: false, shiftKey: true })).toBe("split");
    expect(openModeOf({ ctrlKey: true, shiftKey: true })).toBe("newTab");
  });
});

describe("projectSessionParams (#104)", () => {
  it("takes the name it is given instead of the project's", () => {
    const project: Project = { id: "p", workspaceId: "w1", name: "api", path: "/x", backend: "wsl" };
    expect(projectSessionParams(project, "api 2").name).toBe("api 2");
  });

  const project: Project = {
    id: "p1",
    workspaceId: "w1",
    name: "api",
    path: "/srv/api",
    backend: "wsl",
    distro: "Debian",
  };

  it("starts a shell in the project directory with the name and workspace of the project", () => {
    expect(projectSessionParams(project)).toEqual({
      name: "api",
      workspaceId: "w1",
      launch: { backend: "wsl", distro: "Debian", cwd: "/srv/api" },
    });
  });

  it("leaves the distro out when the project has none, so the configured default applies", () => {
    const { distro: _distro, ...withoutDistro } = project;
    expect(projectSessionParams(withoutDistro).launch).toEqual({ backend: "wsl", cwd: "/srv/api" });
  });
});

describe("confirmations", () => {
  it("says that archiving ends a running process and keeps the history", () => {
    const text = confirmArchive(session("a", { state: "Running", name: "Build" })).message;
    expect(text).toContain("beendet den Prozess");
    expect(text).toContain("Verlauf bleibt");
  });

  it("says that archiving an ended session ends nothing", () => {
    expect(confirmArchive(session("a", { state: "Exited" })).message).not.toContain("beendet den Prozess");
  });

  it("says that deleting a workspace keeps its sessions running and ungroups them", () => {
    expect(confirmDeleteWorkspace(web, 2).message).toContain(
      "2 Sessions bleiben erhalten (laufende Prozesse laufen weiter)",
    );
    expect(confirmDeleteWorkspace(web, 1).message).toContain("Seine Session bleibt erhalten");
    expect(confirmDeleteWorkspace(web, 0).message).not.toContain("Session");
  });
});
