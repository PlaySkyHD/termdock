// A terminal view (taken over from poc/): xterm.js with the fit addon, driven by a TerminalController. One tab
// is one view; the status bar of the window shows its role (App.tsx).
import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { SessionId } from "@termdock/protocol";
import type { TermdockApi } from "../shared/bridge.js";
import { TerminalController } from "./terminal-controller.js";
import type { TerminalSurface, ViewStatus } from "./terminal-controller.js";

/** Same bounds as the bridge in the main process accepts. */
const MAX_COLS = 1_000;
const MAX_ROWS = 500;

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
    proposeSize: () => {
      const size = fit.proposeDimensions();
      if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return undefined;
      return {
        cols: Math.min(MAX_COLS, Math.max(2, Math.floor(size.cols))),
        rows: Math.min(MAX_ROWS, Math.max(1, Math.floor(size.rows))),
      };
    },
    onData: (listener) => {
      const subscription = term.onData(listener);
      return () => subscription.dispose();
    },
  };
}

export interface TerminalViewProps {
  api: TermdockApi;
  sessionId: SessionId;
  /** The tab is the visible one; it takes the keyboard focus. */
  active: boolean;
  /** Changes whenever the window wants the active terminal to take the focus again (clicks on tab or sidebar). */
  focusSignal: number;
  onStatus: (status: ViewStatus | undefined) => void;
  /** Hands the controller to the window (for "Schreibrecht übernehmen"); undefined when the view goes. */
  onController: (controller: TerminalController | undefined) => void;
}

export function TerminalView({
  api,
  sessionId,
  active,
  focusSignal,
  onStatus,
  onController,
}: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>(undefined);
  // The callbacks of the parent change on every render; the view must not attach again for that.
  const callbacks = useRef({ onStatus, onController });
  callbacks.current = { onStatus, onController };
  const activeNow = useRef(active);
  activeNow.current = active;

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
    const current = new TerminalController(api, surfaceOf(term, fit), (status) =>
      callbacks.current.onStatus(status),
    );
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

  return <div className="terminal-view" ref={host} />;
}
