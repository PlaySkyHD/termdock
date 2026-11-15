// The panes of all tabs of a window (#27, #67): every pane is a positioned element of one flat list, keyed by its
// id, so splitting, closing or moving a pane, even into another tab, never attaches a view again (its role and the
// input lock stay). Panes of hidden tabs stay mounted and keep their room. Dividers of the visible tab lie above
// the panes and are dragged with the mouse; while a tab, pane or session is dragged, the pane under the pointer
// shows its five drop zones.
import { useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import type { LayoutTab, SessionId, SessionInfo } from "@termdock/protocol";
import type { TermdockApi } from "../shared/bridge.js";
import { DROP_TARGET_ATTRIBUTE, DROP_ZONES_ATTRIBUTE, useDrag } from "./drag/DragProvider.js";
import { EDGE_SHARE, zonePreview } from "./drag/drop-zones.js";
import type { KeyCommands } from "./keymap.js";
import { PANE_KIND, paneTarget } from "./layout-drop.js";
import { layoutWindow } from "./pane-layout.js";
import type { PlacedDivider, ShareRect } from "./pane-layout.js";
import { paneContent } from "./pane-placeholder.js";
import { paneCount } from "./pane-tree.js";
import { isAttachable, warningTexts } from "./session-display.js";
import type { TerminalController, ViewStatus } from "./terminal-controller.js";
import { TerminalView } from "./TerminalView.js";
import { MIN_SHARE } from "./ui-store.js";

/** No pane gets narrower or lower than this while a divider is dragged. */
const MIN_PANE_PX = 80;

export interface PaneTreeProps {
  api: TermdockApi;
  tabs: readonly LayoutTab[];
  activeTabId: string | undefined;
  sessions: readonly SessionInfo[];
  /** The first list of sessions has arrived (a pane of an unknown session is then a placeholder). */
  sessionsLoaded: boolean;
  focusSignal: number;
  onStatus: (paneId: string, status: ViewStatus | undefined) => void;
  onController: (paneId: string, controller: TerminalController | undefined) => void;
  /** A press in the pane: it becomes active, nothing else (#66). */
  onPanePress: (tabId: string, paneId: string) => void;
  /** "Pane schließen" of a placeholder. */
  onClosePane: (tabId: string, paneId: string) => void;
  /** A bound key was pressed in a pane's terminal (#28). */
  commands: KeyCommands;
  /** Right click on a pane: paste into its view (App). */
  onPanePaste: (paneId: string) => void;
  onMoveDivider: (tabId: string, splitId: string, index: number, delta: number, minShare: number) => void;
  /** Click, menu key or right click on a pane's grip: its menu (#67). */
  onPaneMenu: (paneId: string, event: ReactMouseEvent<HTMLElement>) => void;
  /** Sessions whose warning hint this window has closed (#113). */
  dismissedWarnings: readonly SessionId[];
  /** "Hinweis schließen" of a pane's warning hint (#113). */
  onDismissWarnings: (sessionId: SessionId) => void;
}

export function PaneTree({
  api,
  tabs,
  activeTabId,
  sessions,
  sessionsLoaded,
  focusSignal,
  onStatus,
  onController,
  onPanePress,
  onClosePane,
  commands,
  onPanePaste,
  onMoveDivider,
  onPaneMenu,
  dismissedWarnings,
  onDismissWarnings,
}: PaneTreeProps) {
  const area = useRef<HTMLDivElement>(null);
  const { panes, dividers } = layoutWindow(tabs, activeTabId);
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  return (
    <div className="pane-tree" ref={area}>
      {panes.map(({ paneId, sessionId, rect, tabId, tabActive }) => {
        const tab = byId.get(tabId)!;
        const split = paneCount(tab) > 1;
        const activePane = paneId === tab.activePaneId;
        const session = sessions.find((each) => each.id === sessionId);
        return (
          <div
            key={paneId}
            className={`pane${split && activePane ? " pane--active" : ""}${tabActive ? "" : " pane--hidden"}`}
            style={rectStyle(rect)}
            data-pane-id={paneId}
            data-tab-id={tabId}
            data-tab-active={tabActive}
            data-active-pane={activePane}
            data-session-id={sessionId}
            // Only the visible panes take drops: a hidden one is not under the pointer anyway.
            {...(tabActive
              ? { [DROP_TARGET_ATTRIBUTE]: paneTarget(paneId), [DROP_ZONES_ATTRIBUTE]: "pane" }
              : {})}
            // Capture phase: xterm.js handles mouse events itself when a program (vim, htop) asks for them.
            onMouseDownCapture={() => onPanePress(tabId, paneId)}
          >
            <PaneView
              api={api}
              sessionId={sessionId}
              session={session}
              sessionsLoaded={sessionsLoaded}
              active={tabActive && activePane}
              focusSignal={focusSignal}
              onStatus={(status) => onStatus(paneId, status)}
              onController={(controller) => onController(paneId, controller)}
              onClosePane={() => onClosePane(tabId, paneId)}
              commands={commands}
              onContextPaste={() => onPanePaste(paneId)}
            />
            <WarningHint
              texts={warningTexts(session, dismissedWarnings)}
              onDismiss={() => onDismissWarnings(sessionId)}
            />
            {tabActive && <PaneGrip paneId={paneId} label={session?.name ?? "Pane"} onMenu={onPaneMenu} />}
            {tabActive && <ZoneOverlay paneId={paneId} />}
          </div>
        );
      })}
      {dividers
        .filter((divider) => divider.tabActive)
        .map((divider) => (
          <Divider
            key={`${divider.splitId}:${divider.index}`}
            divider={divider}
            area={area}
            onMove={(splitId, index, delta, minShare) =>
              onMoveDivider(divider.tabId, splitId, index, delta, minShare)
            }
          />
        ))}
    </div>
  );
}

/**
 * Warnings of the pane's session run (#113), at the top edge of the pane. Only the hint takes clicks; the terminal
 * keeps its input and focus. Closing it hides it in this window until the session's next start.
 */
function WarningHint({ texts, onDismiss }: { texts: readonly string[]; onDismiss: () => void }) {
  if (texts.length === 0) return null;
  return (
    <div className="pane-warning" role="status" data-hint="session-warnings">
      <div className="pane-warning__texts">
        {texts.map((text) => (
          <p key={text} className="pane-warning__text">
            {text}
          </p>
        ))}
      </div>
      <button
        className="pane-warning__close"
        type="button"
        data-action="dismiss-warnings"
        aria-label="Hinweis schließen"
        title="Hinweis schließen"
        // The press must not move the focus out of the terminal (the pane becomes active on it anyway).
        onMouseDown={(event) => event.preventDefault()}
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}

/** The handle of a pane (#67): dragging it moves the pane, a click or the menu key opens its menu. */
function PaneGrip({
  paneId,
  label,
  onMenu,
}: {
  paneId: string;
  label: string;
  onMenu: PaneTreeProps["onPaneMenu"];
}) {
  const drag = useDrag();
  return (
    <button
      className="pane-grip"
      type="button"
      data-action="pane-menu"
      aria-haspopup="menu"
      aria-label={`Pane ${label} verschieben`}
      title={"Ziehen: Pane verschieben (auf ein Pane oder die Tab-Leiste)\nKlick oder Menütaste: Aktionen"}
      {...drag.sourceProps({ kind: PANE_KIND, id: paneId, label })}
      onClick={(event) => onMenu(paneId, event)}
      onContextMenu={(event) => onMenu(paneId, event)}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        {[3, 6, 9].flatMap((y) =>
          [4, 8].map((x) => <circle key={`${x}:${y}`} cx={x} cy={y} r="1" fill="currentColor" />),
        )}
      </svg>
    </button>
  );
}

const E = EDGE_SHARE * 100;
/** The five zones in a 100×100 box: the edges are trapezoids between the diagonals, the center the inner box. */
const ZONE_SHAPES: ReadonlyArray<[string, string]> = [
  ["left", `0,0 ${E},${E} ${E},${100 - E} 0,100`],
  ["right", `100,0 ${100 - E},${E} ${100 - E},${100 - E} 100,100`],
  ["top", `0,0 100,0 ${100 - E},${E} ${E},${E}`],
  ["bottom", `0,100 100,100 ${100 - E},${100 - E} ${E},${100 - E}`],
  ["center", `${E},${E} ${100 - E},${E} ${100 - E},${100 - E} ${E},${100 - E}`],
];

/**
 * The drop zones of a pane while something that may land on it is dragged: a dashed frame on every valid pane, on
 * the pane under the pointer the five zones (blocked ones dimmed) and where the drop would land.
 */
function ZoneOverlay({ paneId }: { paneId: string }) {
  const drag = useDrag();
  const { valid, over } = drag.zonesOf(paneTarget(paneId));
  if (valid.length === 0) return null;
  if (over === undefined) return <div className="pane-drop pane-drop--valid" data-drop-overlay="valid" />;
  const preview = zonePreview(over);
  return (
    <div className="pane-drop pane-drop--over" data-drop-overlay={over}>
      <svg className="pane-drop__zones" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {ZONE_SHAPES.map(([zone, points]) => (
          <polygon
            key={zone}
            points={points}
            data-zone={zone}
            className={`pane-drop__zone${valid.includes(zone) ? "" : " pane-drop__zone--blocked"}${
              zone === over ? " pane-drop__zone--over" : ""
            }`}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div
        className="pane-drop__preview"
        style={{
          left: `${preview.left * 100}%`,
          top: `${preview.top * 100}%`,
          width: `${preview.width * 100}%`,
          height: `${preview.height * 100}%`,
        }}
      />
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
  onMove: (splitId: string, index: number, delta: number, minShare: number) => void;
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
      data-tab-active="true"
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
