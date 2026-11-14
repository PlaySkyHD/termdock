// The panes of one tab (#27): every pane is a positioned element of one flat list, keyed by its id, so splitting
// or closing another pane never attaches a view again. Dividers lie above the panes and are dragged with the mouse.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from "react";
import type { LayoutTab, SessionId, SessionInfo } from "@termdock/protocol";
import type { TermdockApi } from "../shared/bridge.js";
import type { KeyCommands } from "./keymap.js";
import { layoutPanes } from "./pane-layout.js";
import type { PlacedDivider, ShareRect } from "./pane-layout.js";
import { paneContent } from "./pane-placeholder.js";
import { isAttachable } from "./session-display.js";
import type { TerminalController, ViewStatus } from "./terminal-controller.js";
import { TerminalView } from "./TerminalView.js";
import { MIN_SHARE } from "./ui-store.js";

/** No pane gets narrower or lower than this while a divider is dragged. */
const MIN_PANE_PX = 80;

export interface PaneTreeProps {
  api: TermdockApi;
  tab: LayoutTab;
  sessions: readonly SessionInfo[];
  /** The first list of sessions has arrived (a pane of an unknown session is then a placeholder). */
  sessionsLoaded: boolean;
  /** The tab is the visible one. */
  active: boolean;
  focusSignal: number;
  onStatus: (paneId: string, status: ViewStatus | undefined) => void;
  onController: (paneId: string, controller: TerminalController | undefined) => void;
  /** A press in the pane: it becomes active, nothing else (#66). */
  onPanePress: (paneId: string) => void;
  /** "Pane schließen" of a placeholder. */
  onClosePane: (paneId: string) => void;
  /** A bound key was pressed in a pane's terminal (#28). */
  commands: KeyCommands;
  /** Right click on a pane: paste into its view (App). */
  onPanePaste: (paneId: string) => void;
  onMoveDivider: (splitId: string, index: number, delta: number, minShare: number) => void;
}

export function PaneTree({
  api,
  tab,
  sessions,
  sessionsLoaded,
  active,
  focusSignal,
  onStatus,
  onController,
  onPanePress,
  onClosePane,
  commands,
  onPanePaste,
  onMoveDivider,
}: PaneTreeProps) {
  const area = useRef<HTMLDivElement>(null);
  const { panes, dividers } = layoutPanes(tab.root);
  const split = panes.length > 1;
  return (
    <div className="pane-tree" ref={area}>
      {panes.map(({ paneId, sessionId, rect }) => (
        <div
          key={paneId}
          className={`pane${split && paneId === tab.activePaneId ? " pane--active" : ""}`}
          style={rectStyle(rect)}
          data-pane-id={paneId}
          data-active-pane={paneId === tab.activePaneId}
          data-session-id={sessionId}
          // Capture phase: xterm.js handles mouse events itself when a program (vim, htop) asks for them.
          onMouseDownCapture={() => onPanePress(paneId)}
        >
          <PaneView
            api={api}
            sessionId={sessionId}
            session={sessions.find((session) => session.id === sessionId)}
            sessionsLoaded={sessionsLoaded}
            active={active && paneId === tab.activePaneId}
            focusSignal={focusSignal}
            onStatus={(status) => onStatus(paneId, status)}
            onController={(controller) => onController(paneId, controller)}
            onClosePane={() => onClosePane(paneId)}
            commands={commands}
            onContextPaste={() => onPanePaste(paneId)}
          />
        </div>
      ))}
      {dividers.map((divider) => (
        <Divider
          key={`${divider.splitId}:${divider.index}`}
          divider={divider}
          area={area}
          onMove={onMoveDivider}
        />
      ))}
    </div>
  );
}

function rectStyle(rect: ShareRect): CSSProperties {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };
}

function Divider({
  divider,
  area,
  onMove,
}: {
  divider: PlacedDivider;
  area: RefObject<HTMLDivElement | null>;
  onMove: PaneTreeProps["onMoveDivider"];
}) {
  // The latest geometry for the pointer handlers; the divider moves under the pointer while it is dragged.
  const current = useRef(divider);
  current.current = divider;
  const [dragging, setDragging] = useState(false);
  const row = divider.direction === "row";

  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const box = area.current?.getBoundingClientRect();
    if (!box || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const { position, split, splitId, index } = current.current;
    // Where the pointer is, as a share of the tab; the store wants the change as a share of the split.
    const pointer = row ? (event.clientX - box.left) / box.width : (event.clientY - box.top) / box.height;
    const splitPx = row ? split.width * box.width : split.height * box.height;
    const splitShare = row ? split.width : split.height;
    if (splitPx <= 0) return;
    onMove(splitId, index, (pointer - position) / splitShare, Math.max(MIN_SHARE, MIN_PANE_PX / splitPx));
  };

  return (
    <div
      className={`divider divider--${divider.direction}${dragging ? " divider--dragging" : ""}`}
      style={dividerStyle(divider)}
      data-divider={`${divider.splitId}:${divider.index}`}
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
      }}
      onLostPointerCapture={() => setDragging(false)}
    />
  );
}

function dividerStyle({ direction, position, split }: PlacedDivider): CSSProperties {
  return direction === "row"
    ? { left: `${position * 100}%`, top: `${split.y * 100}%`, height: `${split.height * 100}%` }
    : { top: `${position * 100}%`, left: `${split.x * 100}%`, width: `${split.width * 100}%` };
}

interface PaneViewProps {
  api: TermdockApi;
  sessionId: SessionId;
  session: SessionInfo | undefined;
  sessionsLoaded: boolean;
  active: boolean;
  focusSignal: number;
  onStatus: (status: ViewStatus | undefined) => void;
  onController: (controller: TerminalController | undefined) => void;
  onClosePane: () => void;
  commands: KeyCommands;
  onContextPaste: () => void;
}

/**
 * One pane. A session that cannot be attached (starting, exited, interrupted) shows a notice instead of a view.
 * Once attached, the view stays when the session ends, so its last output remains readable.
 */
function PaneView({
  api,
  sessionId,
  session,
  sessionsLoaded,
  active,
  focusSignal,
  onStatus,
  onController,
  onClosePane,
  commands,
  onContextPaste,
}: PaneViewProps) {
  const attachable = session !== undefined && isAttachable(session.state);
  const [attached, setAttached] = useState(attachable);
  useEffect(() => {
    if (attachable) setAttached(true);
  }, [attachable]);

  if (attached || attachable) {
    return (
      <TerminalView
        api={api}
        sessionId={sessionId}
        active={active}
        focusSignal={focusSignal}
        onStatus={onStatus}
        onController={onController}
        commands={commands}
        onContextPaste={onContextPaste}
      />
    );
  }
  const content = paneContent(session, sessionsLoaded);
  if (content.kind !== "placeholder")
    return (
      <div className="empty-state" data-view="loading">
        <p>Sessions werden geladen …</p>
      </div>
    );
  // Restored panes of sessions that are not alive (ADR 0005): state and exit code, never "running".
  return (
    <div className="empty-state" data-view="notice" data-state={content.state}>
      <h1 className="empty-state__title">{content.title}</h1>
      <p>{content.detail}</p>
      <dl className="placeholder-facts">
        <dt>Zustand</dt>
        <dd data-fact="state">{content.state}</dd>
        <dt>Letzter Exit-Code</dt>
        <dd data-fact="exit-code">{content.exitCode}</dd>
      </dl>
      <button className="button" type="button" data-action="close-pane-placeholder" onClick={onClosePane}>
        Pane schließen
      </button>
    </div>
  );
}
