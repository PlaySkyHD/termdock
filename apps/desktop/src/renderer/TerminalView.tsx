// A terminal view (taken over from poc/): xterm.js with the fit addon, driven by a TerminalController. One pane
// is one view; the status bar of the window shows the role of the active pane (App.tsx).
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { SessionId } from "@termdock/protocol";
import type { TermdockApi } from "../shared/bridge.js";
import { isClick } from "./pane-layout.js";
import { TerminalController } from "./terminal-controller.js";
import type { TerminalSurface, ViewStatus } from "./terminal-controller.js";
import { usableSize } from "./terminal-size.js";

/** Dark+ colours of VS Code's integrated terminal. */
const THEME = {
  background: "#1e1e1e",
  foreground: "#cccccc",
  cursor: "#aeafad",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

function surfaceOf(term: Terminal, fit: FitAddon): TerminalSurface {
  return {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write: (data) => term.write(data),
    reset: () => term.reset(),
    resize: (cols, rows) => term.resize(cols, rows),
    // xterm.js 6 draws the cursor only after the first focus or key press (`isCursorInitialized`) and has no
    // public API to set it; a reader pane may never be focused. The guarded internal call degrades to nothing.
    showCursor: () => (term as unknown as { _core?: { _showCursor?: () => void } })._core?._showCursor?.(),
    // An area without room for 2 columns and a row (not laid out yet, a pane squeezed to its padding) has no size.
    proposeSize: () => usableSize(fit.proposeDimensions()),
    onData: (listener) => {
      const subscription = term.onData(listener);
      return () => subscription.dispose();
    },
  };
}

export interface TerminalViewProps {
  api: TermdockApi;
  sessionId: SessionId;
  /** Active pane of the visible tab; it takes the keyboard focus. */
  active: boolean;
  /** Changes whenever the window wants the active terminal to take the focus again (clicks on tab or sidebar). */
  focusSignal: number;
  onStatus: (status: ViewStatus | undefined) => void;
  /** Hands the controller to the window (for "Schreibrecht übernehmen"); undefined when the view goes. */
  onController: (controller: TerminalController | undefined) => void;
  /** A real click into the terminal: no drag, no selection (see `isClick`). */
  onClick?: () => void;
}

export function TerminalView({
  api,
  sessionId,
  active,
  focusSignal,
  onStatus,
  onController,
  onClick,
}: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const pressed = useRef<{ x: number; y: number }>(undefined);
  const terminal = useRef<Terminal>(undefined);
  // The callbacks of the parent change on every render; the view must not attach again for that.
  const callbacks = useRef({ onStatus, onController });
  callbacks.current = { onStatus, onController };
  const activeNow = useRef(active);
  activeNow.current = active;
  const [status, setStatus] = useState<ViewStatus>();

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const term = new Terminal({
      fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
      fontSize: 14,
      scrollback: 5_000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    terminal.current = term;
    const current = new TerminalController(api, surfaceOf(term, fit), (next) => {
      setStatus(next);
      callbacks.current.onStatus(next);
    });
    callbacks.current.onController(current);
    void current.open(sessionId);
    const observer = new ResizeObserver(() => current.layoutChanged());
    observer.observe(element);
    if (activeNow.current) term.focus();
    return () => {
      observer.disconnect();
      terminal.current = undefined;
      callbacks.current.onController(undefined);
      callbacks.current.onStatus(undefined);
      void current.dispose();
      term.dispose();
    };
  }, [api, sessionId]);

  useEffect(() => {
    if (active) terminal.current?.focus();
  }, [active, focusSignal]);

  // A reader shows the writer's screen unscaled: clipped where the pane is smaller, dimmed around it (ADR 0006).
  // The frame lies on xterm's screen element and follows its size (writer's size, cell size once fonts load).
  const reader = status?.role === "reader";
  const [frame, setFrame] = useState<{ left: number; top: number; width: number; height: number }>();
  const pane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const screen = host.current?.querySelector(".xterm-screen");
    if (!reader || !screen) return;
    const measure = (): void => {
      const rect = screen.getBoundingClientRect();
      const box = pane.current?.getBoundingClientRect();
      if (box)
        setFrame({
          left: rect.left - box.left,
          top: rect.top - box.top,
          width: rect.width,
          height: rect.height,
        });
    };
    // The screen changes with the writer's size and the cell size; the pane and host with dividers and window.
    const observer = new ResizeObserver(measure);
    observer.observe(screen);
    if (pane.current) observer.observe(pane.current);
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, [reader]);

  return (
    <div
      className="terminal-pane"
      ref={pane}
      data-role={status?.role}
      // Capture phase: xterm.js handles mouse events itself when a program (vim, htop) asks for them.
      onMouseDownCapture={(event) => {
        pressed.current = event.button === 0 ? { x: event.clientX, y: event.clientY } : undefined;
      }}
      onMouseUpCapture={(event) => {
        const down = pressed.current;
        pressed.current = undefined;
        const up = {
          x: event.clientX,
          y: event.clientY,
          detail: event.detail,
          selecting: terminal.current?.hasSelection() ?? false,
        };
        if (event.button === 0 && isClick(down, up)) onClick?.();
      }}
    >
      <div className="terminal-view" ref={host} />
      {reader && frame && <div className="reader-frame" style={frame} />}
      {reader && status.size && (
        <div className="reader-hint" data-hint="writer-size">
          Größe des Schreibers: {status.size.cols}×{status.size.rows}
        </div>
      )}
    </div>
  );
}
