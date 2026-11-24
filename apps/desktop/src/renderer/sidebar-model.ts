// What the sidebar shows and may do (#63): sections from sessions and workspaces, the rules for which drop target
// takes which session, and the entries of the context menus. The rules live here once, so the mouse (drag and
// drop) and the keyboard (context menu) cannot disagree. Pure, no DOM.
import type { BackendKind, Project, SessionCreateParams, SessionInfo, Workspace } from "@termdock/protocol";
import type { DragPayload } from "./drag/drag-model.js";
import type { PaneZone } from "./pane-tree.js";
import { canRestart, persistenceLimit } from "./session-display.js";

export interface WorkspaceSection {
  workspace: Workspace;
  sessions: SessionInfo[];
}

export interface SidebarSections {
  workspaces: WorkspaceSection[];
  /** Sessions without workspace, also those whose workspace this window does not know (nothing disappears). */
  ungrouped: SessionInfo[];
  /** All archived sessions, whatever their workspace. */
  archived: SessionInfo[];
}

/** Workspaces in the order of the core, each with its sessions, then the sessions without group and the archive. */
export function buildSections(
  sessions: readonly SessionInfo[],
  workspaces: readonly Workspace[],
): SidebarSections {
  const known = new Set(workspaces.map((workspace) => workspace.id));
  const live = sessions.filter((session) => session.state !== "Archived");
  return {
    workspaces: workspaces.map((workspace) => ({
      workspace,
      sessions: live.filter((session) => session.workspaceId === workspace.id),
    })),
    ungrouped: live.filter((session) => session.workspaceId === undefined || !known.has(session.workspaceId)),
    archived: sessions.filter((session) => session.state === "Archived"),
  };
}

// --- Drop targets ---------------------------------------------------------------------------------

export const SESSION_KIND = "session";
export const UNGROUPED_TARGET = "ungrouped";
export const ARCHIVE_TARGET = "archive";
const WORKSPACE_PREFIX = "workspace:";

export const workspaceTarget = (workspaceId: string): string => `${WORKSPACE_PREFIX}${workspaceId}`;

/** What dropping a session on a target does. */
export type SessionDrop = { kind: "move"; workspaceId: string | null } | { kind: "archive" };

/** The action of a target id; undefined for an id that is none of the sidebar's. */
export function parseTarget(targetId: string): SessionDrop | undefined {
  if (targetId === UNGROUPED_TARGET) return { kind: "move", workspaceId: null };
  if (targetId === ARCHIVE_TARGET) return { kind: "archive" };
  if (targetId.startsWith(WORKSPACE_PREFIX) && targetId.length > WORKSPACE_PREFIX.length)
    return { kind: "move", workspaceId: targetId.slice(WORKSPACE_PREFIX.length) };
  return undefined;
}

export function sessionPayload(session: SessionInfo): DragPayload {
  return { kind: SESSION_KIND, id: session.id, label: session.name };
}

/** Which moves a session may make. An archived session is final and goes nowhere; it is not even draggable. */
export function canDrop(session: SessionInfo, drop: SessionDrop, workspaces: readonly Workspace[]): boolean {
  if (session.state === "Archived") return false;
  if (drop.kind === "archive") return canArchive(session);
  if (drop.workspaceId === null) return session.workspaceId !== undefined;
  return session.workspaceId !== drop.workspaceId && workspaces.some((each) => each.id === drop.workspaceId);
}

/** The lifecycle has no way from `Starting` to `Archived` (ADR 0005); the core would refuse with `invalid_state`. */
export function canArchive(session: SessionInfo): boolean {
  return session.state !== "Archived" && session.state !== "Starting";
}

export function isDraggable(session: SessionInfo): boolean {
  return session.state !== "Archived";
}

/** Only a session without a live process can be deleted (the core refuses the others with `invalid_state`). */
export function canDelete(session: SessionInfo): boolean {
  return session.state === "Exited" || session.state === "Interrupted" || session.state === "Archived";
}

// --- Context menus --------------------------------------------------------------------------------

export interface MenuEntry<A> {
  /** Stable key, also the `data-menu-item` of the element. */
  key: string;
  label: string;
  action: A;
  disabled?: boolean;
  /** Why an entry is disabled. */
  hint?: string;
  danger?: boolean;
  /** A line above the entry. */
  separator?: boolean;
}

export type SessionAction =
  | { kind: "open" }
  /** Opens it in a zone of the active pane (#67). */
  | { kind: "place"; zone: PaneZone }
  | { kind: "rename" }
  | { kind: "move"; workspaceId: string | null }
  | { kind: "archive" }
  | { kind: "delete" }
  /** `session.restart` of an ended or interrupted session (#156). */
  | { kind: "restart" };

/**
 * `offered`: the entries that open the session in a zone of the active pane (`sessionPlaceEntries`, #67). Like
 * dragging onto a pane, they are only for a session that may be dragged (not an archived one).
 */
export function sessionMenu(
  session: SessionInfo,
  workspaces: readonly Workspace[],
  offered: readonly MenuEntry<PaneZone>[] = [],
): MenuEntry<SessionAction>[] {
  const places = isDraggable(session) ? offered : [];
  const entries: MenuEntry<SessionAction>[] = [
    { key: "open", label: "Öffnen", action: { kind: "open" } },
    // Only where the core takes it; no disabled entry for living sessions, they have nothing to restart (#156).
    ...(canRestart(session.state)
      ? [{ key: "restart", label: "Neu starten", action: { kind: "restart" as const } }]
      : []),
    ...places.map((place) => ({ ...place, action: { kind: "place" as const, zone: place.action } })),
    {
      key: "rename",
      label: "Umbenennen …",
      action: { kind: "rename" },
      ...(places.length > 0 ? { separator: true } : {}),
    },
  ];
  let first = true;
  for (const workspace of workspaces) {
    const action: SessionDrop = { kind: "move", workspaceId: workspace.id };
    if (canDrop(session, action, workspaces)) {
      entries.push({
        key: `move:${workspace.id}`,
        label: `Verschieben nach ${workspace.name}`,
        action,
        ...(first ? { separator: true } : {}),
      });
      first = false;
    }
  }
  if (canDrop(session, { kind: "move", workspaceId: null }, workspaces))
    entries.push({
      key: "move:",
      label: "Verschieben nach Ohne Gruppe",
      action: { kind: "move", workspaceId: null },
      ...(first ? { separator: true } : {}),
    });
  if (session.state !== "Archived")
    entries.push({
      key: "archive",
      label: "Archivieren …",
      action: { kind: "archive" },
      separator: true,
      ...(canArchive(session)
        ? {}
        : { disabled: true, hint: "Eine startende Session lässt sich nicht archivieren" }),
    });
  const deletable = canDelete(session);
  entries.push({
    key: "delete",
    label: "Löschen …",
    action: { kind: "delete" },
    danger: true,
    // Archived sessions have no other entry above; the line only separates the destructive one.
    separator: session.state === "Archived",
    ...(deletable ? {} : { disabled: true, hint: "Nur beendete, unterbrochene oder archivierte Sessions" }),
  });
  return entries;
}

export type WorkspaceAction = { kind: "rename" } | { kind: "addProject" } | { kind: "delete" };

export function workspaceMenu(): MenuEntry<WorkspaceAction>[] {
  return [
    { key: "rename", label: "Umbenennen …", action: { kind: "rename" } },
    { key: "addProject", label: "Projekt hinzufügen …", action: { kind: "addProject" } },
    { key: "delete", label: "Löschen …", action: { kind: "delete" }, danger: true, separator: true },
  ];
}

/** `tab`: open or focus the tab; `newTab`: always a new tab; `split`: next to the active pane. */
export type OpenMode = "tab" | "newTab" | "split";

/** Click with modifiers to the way a session opens: Ctrl a new tab, Shift next to the active pane, else the tab. */
export function openModeOf(event: { ctrlKey: boolean; shiftKey: boolean }): OpenMode {
  return event.ctrlKey ? "newTab" : event.shiftKey ? "split" : "tab";
}

/**
 * `session.create` for a session in the project (#104): `name` (the project's by default) and its workspace, a shell in the project directory
 * (backend and distro of the project; no command, environment or profile: those are the profile editor's, #64).
 * The protocol has no `projectId` on a session, so the project is not recorded on it.
 */
export function projectSessionParams(project: Project, name: string = project.name): SessionCreateParams {
  return {
    name,
    workspaceId: project.workspaceId,
    launch: {
      backend: project.backend,
      ...(project.distro === undefined ? {} : { distro: project.distro }),
      cwd: project.path,
    },
  };
}

/** A field of the dialog "Projekt in …"; `NameField` of `Dialogs.tsx` fits. */
export interface ProjectField {
  key: "name" | "backend" | "path";
  label: string;
  value: string;
  options?: ReadonlyArray<{ value: BackendKind; label: string }>;
  note?: (values: readonly string[]) => string | undefined;
}

/**
 * Name, backend and path of a new project (#65), in this order. The note under the backend names the persistence
 * limit while Windows is chosen; the core checks the path against the backend (Linux path for WSL, drive or UNC path
 * for Windows) and the dialog shows its refusal.
 */
export function newProjectFields(): ProjectField[] {
  return [
    { key: "name", label: "Name", value: "" },
    {
      key: "backend",
      label: "Backend",
      value: "wsl",
      options: [
        { value: "wsl", label: "WSL" },
        { value: "windows", label: "Windows-Shell" },
      ],
      note: (values) =>
        values[1] === "windows" ? persistenceLimit({ backend: "windows" })?.note : undefined,
    },
    { key: "path", label: "Pfad (WSL: /home/…, Windows: C:\\…)", value: "/home" },
  ];
}

/** `project.create` from the values of `newProjectFields`, trimmed as the dialog passes them. */
export function newProjectInput(values: readonly string[]): {
  name: string;
  backend: BackendKind;
  path: string;
} {
  return {
    name: values[0] ?? "",
    backend: values[1] === "windows" ? "windows" : "wsl",
    path: values[2] ?? "",
  };
}

export type ProjectAction = { kind: "start" } | { kind: "rename" } | { kind: "delete" };

export function projectMenu(): MenuEntry<ProjectAction>[] {
  return [
    { key: "start", label: "Neue Session hier", action: { kind: "start" } },
    { key: "rename", label: "Umbenennen …", action: { kind: "rename" } },
    { key: "delete", label: "Löschen …", action: { kind: "delete" }, danger: true, separator: true },
  ];
}

// --- Where the focus goes after an action ----------------------------------------------------------

/**
 * The element that gets the keyboard focus once a menu action or a dialog is through; without it the focus falls
 * to `<body>` and the keyboard user starts again from the top. `waitFor`: a move shows up in the window only with
 * the event of the core, so the plan waits until the session is in its new group.
 */
export interface FocusPlan {
  selector: string;
  waitFor?: { sessionId: string; workspaceId: string | null } | { sessionId: string; archived: true };
}

/** The focus of last resort: the "+" of the sidebar header, which is always there. */
export const SIDEBAR_FOCUS: FocusPlan = { selector: '.sidebar [data-action="new-session"]' };
export const NEW_WORKSPACE_FOCUS: FocusPlan = { selector: '.sidebar [data-action="new-workspace"]' };

export const sessionFocus = (sessionId: string, waitFor?: FocusPlan["waitFor"]): FocusPlan => ({
  // Not `data-session-id`: the panes of the tabs carry that one.
  selector: `[data-row-session-id=${JSON.stringify(sessionId)}]`,
  ...(waitFor ? { waitFor } : {}),
});
export const workspaceFocus = (workspaceId: string): FocusPlan => ({
  selector: `[data-workspace-id=${JSON.stringify(workspaceId)}] [data-action="workspace-menu"]`,
});
export const projectFocus = (projectId: string): FocusPlan => ({
  selector: `[data-project-id=${JSON.stringify(projectId)}]`,
});

/** The plan can be carried out now: nothing to wait for, the session is gone, or it is in the awaited group. */
export function focusReady(plan: FocusPlan, sessions: readonly SessionInfo[]): boolean {
  if (!plan.waitFor) return true;
  const session = sessions.find((each) => each.id === plan.waitFor?.sessionId);
  if (session === undefined) return true;
  return "archived" in plan.waitFor
    ? session.state === "Archived"
    : (session.workspaceId ?? null) === plan.waitFor.workspaceId;
}

// --- Confirmations --------------------------------------------------------------------------------

export interface Confirmation {
  title: string;
  message: string;
  /** Label of the confirming button. */
  confirm: string;
}

export function confirmArchive(session: SessionInfo): Confirmation {
  const running = session.state === "Running" || session.state === "Detached";
  return {
    title: "Session archivieren?",
    message: running
      ? `„${session.name}“ läuft noch. Archivieren beendet den Prozess; der Verlauf bleibt erhalten, und die Session lässt sich nicht mehr starten.`
      : `„${session.name}“ wird ins Archiv verschoben und lässt sich nicht mehr starten. Der Verlauf bleibt erhalten.`,
    confirm: "Archivieren",
  };
}

export function confirmDeleteSession(session: SessionInfo): Confirmation {
  return {
    title: "Session löschen?",
    message: `„${session.name}“ wird endgültig gelöscht, auch ihr gespeicherter Verlauf. Das lässt sich nicht rückgängig machen.`,
    confirm: "Löschen",
  };
}

/** `sessionCount`: the sessions shown in the workspace; archived ones stay in the archive, they are not counted. */
export function confirmDeleteWorkspace(workspace: Workspace, sessionCount: number): Confirmation {
  const sessions =
    sessionCount === 0
      ? ""
      : sessionCount === 1
        ? " Seine Session bleibt erhalten (ein laufender Prozess läuft weiter) und steht danach unter „Ohne Gruppe“."
        : ` Seine ${sessionCount} Sessions bleiben erhalten (laufende Prozesse laufen weiter) und stehen danach unter „Ohne Gruppe“.`;
  return {
    title: "Workspace löschen?",
    message: `„${workspace.name}“ und seine Projekte werden gelöscht.${sessions}`,
    confirm: "Löschen",
  };
}

export function confirmDeleteProject(project: Project): Confirmation {
  return {
    title: "Projekt löschen?",
    message: `„${project.name}“ wird aus dem Workspace entfernt. Das Verzeichnis ${project.path} bleibt unberührt.`,
    confirm: "Löschen",
  };
}
