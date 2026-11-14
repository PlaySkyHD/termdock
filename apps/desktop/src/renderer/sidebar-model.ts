// What the sidebar shows and may do (#63): sections from sessions and workspaces, the rules for which drop target
// takes which session, and the entries of the context menus. The rules live here once, so the mouse (drag and
// drop) and the keyboard (context menu) cannot disagree. Pure, no DOM.
import type { Project, SessionInfo, Workspace } from "@termdock/protocol";
import type { DragPayload } from "./drag/drag-model.js";

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
  if (drop.kind === "archive") return true;
  if (drop.workspaceId === null) return session.workspaceId !== undefined;
  return session.workspaceId !== drop.workspaceId && workspaces.some((each) => each.id === drop.workspaceId);
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
  | { kind: "rename" }
  | { kind: "move"; workspaceId: string | null }
  | { kind: "archive" }
  | { kind: "delete" };

export function sessionMenu(
  session: SessionInfo,
  workspaces: readonly Workspace[],
): MenuEntry<SessionAction>[] {
  const entries: MenuEntry<SessionAction>[] = [
    { key: "open", label: "Öffnen", action: { kind: "open" } },
    { key: "rename", label: "Umbenennen …", action: { kind: "rename" } },
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
    entries.push({ key: "archive", label: "Archivieren …", action: { kind: "archive" }, separator: true });
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

export type ProjectAction = { kind: "rename" } | { kind: "delete" };

export function projectMenu(): MenuEntry<ProjectAction>[] {
  return [
    { key: "rename", label: "Umbenennen …", action: { kind: "rename" } },
    { key: "delete", label: "Löschen …", action: { kind: "delete" }, danger: true, separator: true },
  ];
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
