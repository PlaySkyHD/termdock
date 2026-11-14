// Sidebar (#63): workspaces with their projects and sessions, the sessions without a group, and the archive.
// Sessions move by drag and drop or the context menu (same rules, `sidebar-model.ts`); deleting and archiving ask
// first. The form for a new WSL session sits at the top.
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { Project, SessionId, SessionInfo, Workspace } from "@termdock/protocol";
import { ContextMenu } from "./ContextMenu.js";
import { ConfirmDialog, failureText, NameDialog } from "./Dialogs.js";
import type { NameField } from "./Dialogs.js";
import { DragProvider, useDrag } from "./drag/DragProvider.js";
import type { DragPayload } from "./drag/drag-model.js";
import { NO_GROUP_LABEL, stateText } from "./session-display.js";
import {
  ARCHIVE_TARGET,
  buildSections,
  canDrop,
  confirmArchive,
  confirmDeleteProject,
  confirmDeleteSession,
  confirmDeleteWorkspace,
  isDraggable,
  parseTarget,
  projectMenu,
  SESSION_KIND,
  sessionMenu,
  sessionPayload,
  UNGROUPED_TARGET,
  workspaceMenu,
  workspaceTarget,
} from "./sidebar-model.js";
import type { Confirmation, MenuEntry, SessionAction } from "./sidebar-model.js";
import { StateIcon } from "./StateIcon.js";

/** `tab`: open or focus the tab; `newTab`: always a new tab; `split`: next to the active pane. */
export type OpenMode = "tab" | "newTab" | "split";

/** What the sidebar asks of the window. Each rejects with the reason (the message of the core). */
export interface SidebarActions {
  moveSession(sessionId: SessionId, workspaceId: string | null): Promise<void>;
  renameSession(sessionId: SessionId, name: string): Promise<void>;
  archiveSession(sessionId: SessionId): Promise<void>;
  deleteSession(sessionId: SessionId): Promise<void>;
  createWorkspace(name: string): Promise<void>;
  renameWorkspace(workspaceId: string, name: string): Promise<void>;
  deleteWorkspace(workspaceId: string): Promise<void>;
  createProject(workspaceId: string, name: string, path: string): Promise<void>;
  renameProject(projectId: string, name: string): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
}

export interface SidebarProps {
  sessions: readonly SessionInfo[];
  workspaces: readonly Workspace[];
  /** Session of the active pane of the active tab. */
  activeSessionId: SessionId | undefined;
  formOpen: boolean;
  /** A create is in flight (owned by the window, so it survives hiding the sidebar). */
  creating: boolean;
  /** Message of the last failed create. */
  createError: string | undefined;
  actions: SidebarActions;
  /** A failure of an action that has no dialog (a move by drag and drop or menu) goes to the status bar. */
  onNotice: (message: string) => void;
  onFormOpen: (open: boolean) => void;
  /** Click opens or focuses the tab; Ctrl+click always opens a new one; Shift+click splits the active pane. */
  onOpen: (sessionId: SessionId, mode: OpenMode) => void;
  /** Starts creating the session and opening its tab; `creating` and `createError` report the outcome. */
  onCreate: (name: string, cwd: string) => void;
}

type Dialog =
  | { kind: "confirm"; confirmation: Confirmation; run: () => Promise<void> }
  | {
      kind: "name";
      title: string;
      fields: readonly NameField[];
      submit: string;
      run: (values: string[]) => Promise<void>;
    };

interface MenuState {
  x: number;
  y: number;
  label: string;
  entries: readonly MenuEntry<() => void>[];
  /** Gets the focus back when the menu closes without a choice. */
  opener: HTMLElement | null;
}

export function Sidebar(props: SidebarProps) {
  const { sessions, workspaces, actions, onNotice, onOpen } = props;
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>();
  const [menu, setMenu] = useState<MenuState>();
  const sections = buildSections(sessions, workspaces);
  const sessionById = (id: string): SessionInfo | undefined => sessions.find((session) => session.id === id);

  const closeDialog = (): void => setDialog(undefined);
  /**
   * Closes `own` once its action has worked, but not a dialog the user opened meanwhile (a slow archive can be
   * cancelled with Escape and another dialog opened before it answers).
   */
  const closeIfCurrent = (own: Dialog): void =>
    setDialog((current) => (current === own ? undefined : current));
  /** Runs `action`, closes the dialog when it worked; its failure stays in the dialog. */
  const confirm = (confirmation: Confirmation, action: () => Promise<void>): void => {
    const own: Dialog = {
      kind: "confirm",
      confirmation,
      run: async () => {
        await action();
        closeIfCurrent(own);
      },
    };
    setDialog(own);
  };
  const ask = (
    title: string,
    fields: readonly NameField[],
    submit: string,
    action: (values: string[]) => Promise<void>,
  ): void => {
    const own: Dialog = {
      kind: "name",
      title,
      fields,
      submit,
      run: async (values) => {
        await action(values);
        closeIfCurrent(own);
      },
    };
    setDialog(own);
  };
  /** A failure without a dialog (drag and drop, menu) goes to the status bar. */
  const quietly = (action: Promise<void>): void =>
    void action.catch((error: unknown) => onNotice(failureText(error)));

  const archive = (session: SessionInfo): void =>
    confirm(confirmArchive(session), () => actions.archiveSession(session.id));
  const remove = (session: SessionInfo): void =>
    confirm(confirmDeleteSession(session), () => actions.deleteSession(session.id));

  const runSession = (session: SessionInfo, action: SessionAction): void => {
    switch (action.kind) {
      case "open":
        onOpen(session.id, "tab");
        return;
      case "rename":
        ask(
          "Session umbenennen",
          [{ key: "name", label: "Name", value: session.name }],
          "Umbenennen",
          ([name]) => actions.renameSession(session.id, name!),
        );
        return;
      case "move":
        quietly(actions.moveSession(session.id, action.workspaceId));
        return;
      case "archive":
        archive(session);
        return;
      case "delete":
        remove(session);
        return;
    }
  };

  const runWorkspace = (workspace: Workspace, kind: "rename" | "addProject" | "delete"): void => {
    switch (kind) {
      case "rename":
        ask(
          "Workspace umbenennen",
          [{ key: "name", label: "Name", value: workspace.name }],
          "Umbenennen",
          ([name]) => actions.renameWorkspace(workspace.id, name!),
        );
        return;
      case "addProject":
        ask(
          `Projekt in „${workspace.name}“`,
          [
            { key: "name", label: "Name", value: "" },
            { key: "path", label: "Pfad in WSL (absolut)", value: "/home" },
          ],
          "Anlegen",
          ([name, path]) => actions.createProject(workspace.id, name!, path!),
        );
        return;
      case "delete": {
        const count =
          sections.workspaces.find((each) => each.workspace.id === workspace.id)?.sessions.length ?? 0;
        confirm(confirmDeleteWorkspace(workspace, count), () => actions.deleteWorkspace(workspace.id));
        return;
      }
    }
  };

  const runProject = (project: Project, kind: "rename" | "delete"): void => {
    if (kind === "rename")
      ask(
        "Projekt umbenennen",
        [{ key: "name", label: "Name", value: project.name }],
        "Umbenennen",
        ([name]) => actions.renameProject(project.id, name!),
      );
    else confirm(confirmDeleteProject(project), () => actions.deleteProject(project.id));
  };

  /** Opens a menu at the pointer, or beside the element when the keyboard asked for it. */
  const openMenu = (
    event: ReactMouseEvent<HTMLElement>,
    label: string,
    entries: readonly MenuEntry<() => void>[],
  ): void => {
    event.preventDefault();
    const element = event.currentTarget;
    const box = element.getBoundingClientRect();
    // The menu key and Shift+F10 send `contextmenu` without a pointer position, Enter on a button a `click`
    // without a click count; the menu then opens beside the element.
    const fromKeyboard =
      event.type === "click" ? event.detail === 0 : event.clientX === 0 && event.clientY === 0;
    setMenu({
      x: fromKeyboard ? box.left + 24 : event.clientX,
      y: fromKeyboard ? box.bottom : event.clientY,
      label,
      entries,
      opener: element,
    });
  };

  const sessionEntries = (session: SessionInfo): MenuEntry<() => void>[] =>
    sessionMenu(session, workspaces).map((entry) => ({
      ...entry,
      action: () => runSession(session, entry.action),
    }));
  const workspaceEntries = (workspace: Workspace): MenuEntry<() => void>[] =>
    workspaceMenu().map((entry) => ({ ...entry, action: () => runWorkspace(workspace, entry.action.kind) }));
  const projectEntries = (project: Project): MenuEntry<() => void>[] =>
    projectMenu().map((entry) => ({ ...entry, action: () => runProject(project, entry.action.kind) }));

  const accepts = (payload: DragPayload, targetId: string): boolean => {
    const session = payload.kind === SESSION_KIND ? sessionById(payload.id) : undefined;
    const drop = parseTarget(targetId);
    return session !== undefined && drop !== undefined && canDrop(session, drop, workspaces);
  };

  const drop = (payload: DragPayload, targetId: string): void => {
    const session = payload.kind === SESSION_KIND ? sessionById(payload.id) : undefined;
    const target = parseTarget(targetId);
    if (!session || !target || !canDrop(session, target, workspaces)) return;
    if (target.kind === "archive") archive(session);
    else quietly(actions.moveSession(session.id, target.workspaceId));
  };

  const row = (session: SessionInfo, options: { archived?: boolean } = {}): ReactNode => (
    <SessionRow
      key={session.id}
      session={session}
      active={session.id === props.activeSessionId}
      onOpen={onOpen}
      onMenu={(event) => openMenu(event, `Aktionen für ${session.name}`, sessionEntries(session))}
      onDelete={options.archived ? () => remove(session) : undefined}
    />
  );

  return (
    <DragProvider accepts={accepts} onDrop={drop}>
      <aside className="sidebar" aria-label="Sessions">
        <header className="sidebar__header">
          <span className="sidebar__title">Sessions</span>
          <button
            className="icon-button"
            type="button"
            data-action="new-session"
            title="Neue WSL-Session"
            aria-label="Neue WSL-Session"
            onClick={() => props.onFormOpen(!props.formOpen)}
          >
            +
          </button>
        </header>
        {props.formOpen && (
          <NewSessionForm
            busy={props.creating}
            error={props.createError}
            onCreate={props.onCreate}
            onCancel={() => props.onFormOpen(false)}
          />
        )}
        <div className="sidebar__groups">
          {sections.workspaces.map(({ workspace, sessions: inside }) => (
            <DropSection
              key={workspace.id}
              targetId={workspaceTarget(workspace.id)}
              label={workspace.name}
              data={{ "data-workspace-name": workspace.name }}
            >
              <div className="sidebar__group-header">
                <h2
                  className="sidebar__group-title"
                  onContextMenu={(event) =>
                    openMenu(event, `Aktionen für ${workspace.name}`, workspaceEntries(workspace))
                  }
                >
                  {workspace.name}
                </h2>
                <button
                  className="icon-button sidebar__group-menu"
                  type="button"
                  data-action="workspace-menu"
                  aria-haspopup="menu"
                  title={`Aktionen für ${workspace.name}`}
                  aria-label={`Aktionen für ${workspace.name}`}
                  onClick={(event) =>
                    openMenu(event, `Aktionen für ${workspace.name}`, workspaceEntries(workspace))
                  }
                >
                  ⋯
                </button>
              </div>
              <ul className="sidebar__list">
                {workspace.projects.map((project) => (
                  <li key={project.id}>
                    <button
                      className="project-item"
                      type="button"
                      data-project-name={project.name}
                      aria-haspopup="menu"
                      title={`${project.name} · ${project.path}\nKlick oder Rechtsklick: Aktionen`}
                      onClick={(event) =>
                        openMenu(event, `Aktionen für ${project.name}`, projectEntries(project))
                      }
                      onContextMenu={(event) =>
                        openMenu(event, `Aktionen für ${project.name}`, projectEntries(project))
                      }
                    >
                      <span className="project-icon" aria-hidden="true" />
                      <span className="session-item__name">{project.name}</span>
                      <span className="session-item__state">{project.path}</span>
                    </button>
                  </li>
                ))}
                {inside.map((session) => row(session))}
                {inside.length === 0 && workspace.projects.length === 0 && (
                  <li className="sidebar__empty">Leer – Session hierher ziehen</li>
                )}
              </ul>
            </DropSection>
          ))}
          <DropSection targetId={UNGROUPED_TARGET} label={NO_GROUP_LABEL}>
            <h2 className="sidebar__group-title">{NO_GROUP_LABEL}</h2>
            <ul className="sidebar__list">
              {sections.ungrouped.length === 0 && <li className="sidebar__empty">Keine Sessions</li>}
              {sections.ungrouped.map((session) => row(session))}
            </ul>
          </DropSection>
          <DropSection targetId={ARCHIVE_TARGET} label="Archiv" extraClass="sidebar__archive">
            <h2 className="sidebar__group-title">
              <button
                className="archive-toggle"
                type="button"
                data-archive-toggle=""
                aria-expanded={archiveOpen}
                onClick={() => setArchiveOpen(!archiveOpen)}
              >
                <span aria-hidden="true">{archiveOpen ? "▾" : "▸"}</span> Archiv{" "}
                <span className="archive-toggle__count" data-archive-count="">
                  {sections.archived.length}
                </span>
              </button>
            </h2>
            {archiveOpen && (
              <ul className="sidebar__list" data-archive-list="">
                {sections.archived.length === 0 && (
                  <li className="sidebar__empty">Keine archivierten Sessions</li>
                )}
                {sections.archived.map((session) => row(session, { archived: true }))}
              </ul>
            )}
          </DropSection>
        </div>
        <footer className="sidebar__footer">
          <button
            className="sidebar__add"
            type="button"
            data-action="new-workspace"
            onClick={() =>
              ask("Neuer Workspace", [{ key: "name", label: "Name", value: "" }], "Anlegen", ([name]) =>
                actions.createWorkspace(name!),
              )
            }
          >
            + Neuer Workspace
          </button>
        </footer>
      </aside>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.label}
          entries={menu.entries}
          onClose={(chosen) => {
            setMenu(undefined);
            if (!chosen) menu.opener?.focus();
          }}
        />
      )}
      {dialog?.kind === "confirm" && (
        <ConfirmDialog confirmation={dialog.confirmation} onConfirm={dialog.run} onCancel={closeDialog} />
      )}
      {dialog?.kind === "name" && (
        <NameDialog
          title={dialog.title}
          fields={dialog.fields}
          submitLabel={dialog.submit}
          onSubmit={dialog.run}
          onCancel={closeDialog}
        />
      )}
    </DragProvider>
  );
}

/** A group of the sidebar that takes dropped sessions and lights up while one is dragged. */
function DropSection({
  targetId,
  label,
  extraClass,
  data,
  children,
}: {
  targetId: string;
  label: string;
  extraClass?: string;
  data?: Record<string, string>;
  children: ReactNode;
}) {
  const drag = useDrag();
  return (
    <section
      className={`sidebar__group ${drag.targetClass(targetId)}${extraClass ? ` ${extraClass}` : ""}`}
      aria-label={label}
      data-drop-target={targetId}
      {...data}
    >
      {children}
    </section>
  );
}

function SessionRow({
  session,
  active,
  onOpen,
  onMenu,
  onDelete,
}: {
  session: SessionInfo;
  active: boolean;
  onOpen: SidebarProps["onOpen"];
  onMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  /** Set in the archive: the row gets its own "Löschen". */
  onDelete: (() => void) | undefined;
}) {
  const drag = useDrag();
  const sourceProps = isDraggable(session) ? drag.sourceProps(sessionPayload(session)) : {};
  return (
    <li className="session-row">
      <button
        className={`session-item${active ? " session-item--active" : ""}${
          session.state === "Exited" || session.state === "Interrupted" || session.state === "Archived"
            ? " session-item--ended"
            : ""
        }`}
        type="button"
        data-session-name={session.name}
        data-state={session.state}
        aria-haspopup="menu"
        title={`${session.name} · ${stateText(session)}\nStrg+Klick: in neuem Tab öffnen\nUmschalt+Klick: neben dem aktiven Pane öffnen (dieselbe Session liest dort mit)\nZiehen auf einen Workspace oder das Archiv, Rechtsklick oder Menütaste für Aktionen`}
        {...sourceProps}
        onClick={(event) => onOpen(session.id, event.ctrlKey ? "newTab" : event.shiftKey ? "split" : "tab")}
        onContextMenu={onMenu}
      >
        <StateIcon session={session} />
        <span className="session-item__name">{session.name}</span>
        <span className="session-item__state">{stateText(session)}</span>
      </button>
      {onDelete && (
        <button
          className="session-row__delete"
          type="button"
          data-archive-delete={session.name}
          title={`„${session.name}“ löschen`}
          aria-label={`„${session.name}“ löschen`}
          onClick={onDelete}
        >
          Löschen
        </button>
      )}
    </li>
  );
}

function NewSessionForm({
  busy,
  error,
  onCreate,
  onCancel,
}: {
  busy: boolean;
  error: string | undefined;
  onCreate: SidebarProps["onCreate"];
  onCancel: () => void;
}) {
  const [name, setName] = useState("WSL");
  const [cwd, setCwd] = useState("~");
  const nameField = useRef<HTMLInputElement>(null);
  useEffect(() => nameField.current?.select(), []);

  const submit = (): void => {
    if (busy || name.trim() === "") return;
    // The creating may take long when WSL starts cold (up to 60 s); the window keeps its state, also when the
    // sidebar is hidden meanwhile.
    onCreate(name.trim(), cwd.trim() === "" ? "~" : cwd.trim());
  };

  return (
    <form
      className="new-session"
      data-form="new-session"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <label className="new-session__field">
        Name
        <input
          ref={nameField}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="new-session__field">
        Arbeitsverzeichnis
        <input
          value={cwd}
          disabled={busy}
          spellCheck={false}
          onChange={(event) => setCwd(event.target.value)}
        />
      </label>
      {busy && <p className="new-session__note">Wird angelegt …</p>}
      {error && <p className="new-session__error">{error}</p>}
      <div className="new-session__actions">
        <button className="button button--primary" type="submit" disabled={busy || name.trim() === ""}>
          Anlegen
        </button>
        <button className="button" type="button" disabled={busy} onClick={onCancel}>
          Abbrechen
        </button>
      </div>
    </form>
  );
}
