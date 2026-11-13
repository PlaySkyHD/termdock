// A terminal view (taken over from poc/): xterm.js with the fit addon, driven by a TerminalController.
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { SessionInfo } from "@termdock/protocol";
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

export function TerminalView({ api, session }: { api: TermdockApi; session: SessionInfo }) {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<TerminalController>(undefined);
  const [status, setStatus] = useState<ViewStatus>({ role: "connecting" });

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
    const current = new TerminalController(api, surfaceOf(term, fit), setStatus);
    controller.current = current;
    void current.open(session.id);
    const observer = new ResizeObserver(() => current.layoutChanged());
    observer.observe(element);
    term.focus();
    return () => {
      observer.disconnect();
      controller.current = undefined;
      void current.dispose();
      term.dispose();
    };
  }, [api, session.id]);

  const reader = status.role === "reader";
  return (
    <div className="terminal-view">
      <div className={`terminal-view__screen${reader ? " terminal-view__screen--reader" : ""}`} ref={host} />
      <footer className={`status-bar status-bar--${status.role}`}>
        <span className="status-bar__item">{session.name}</span>
        <span className="status-bar__item">{status.state ?? session.state}</span>
        <span className="status-bar__item">{roleText(status)}</span>
        {status.size && (
          <span className="status-bar__item">
            {status.size.cols}×{status.size.rows}
          </span>
        )}
        <span className="status-bar__spacer" />
        {status.error && status.role !== "error" && (
          <span className="status-bar__item status-bar__item--error">{status.error}</span>
        )}
        {reader && (
          <button
            className="status-bar__button"
            type="button"
            // claimWriter never rejects; a refusal arrives as status.error.
            onClick={() => void controller.current?.claimWriter()}
          >
            Schreibrecht übernehmen
          </button>
        )}
      </footer>
    </div>
  );
}

function roleText(status: ViewStatus): string {
  switch (status.role) {
    case "connecting":
      return "Verbinde …";
    case "writer":
      return "Schreibt";
    case "reader":
      return "Liest";
    case "closed":
      return "Verbindung zum Core getrennt";
    case "error":
      return `Fehler: ${status.error ?? "unbekannt"}`;
  }
}
