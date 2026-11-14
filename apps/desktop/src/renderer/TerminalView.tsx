// A terminal view (taken over from poc/): xterm.js with the fit addon, driven by a TerminalController. One pane
// is one view; the status bar of the window shows the role of the active pane (App.tsx).
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { SessionId } from "@termdock/protocol";
import type { TermdockApi } from "../shared/bridge.js";
import type { KeyCommands } from "./keymap.js";
import { takesInput } from "./pane-layout.js";
import { TerminalController } from "./terminal-controller.js";
import type { TerminalSurface, ViewStatus } from "./terminal-controller.js";
import { NORMAL_FONT_SIZE, usableSize } from "./terminal-size.js";

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

/** Width the fit addon keeps free for the scroll bar (xterm.js 6 with scrollback, no overview ruler). */
const SCROLL_BAR_PX = 14;

/** Cell size in CSS px as xterm.js renders it; the fit addon reads the same (guarded internal access). */
function cellOf(term: Terminal): { width: number; height: number } | undefined {
  const internal = term as unknown as {
    _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } };
  };
  const cell = internal._core?._renderService?.dimensions?.css?.cell;
  return cell && cell.width > 0 && cell.height > 0 ? { width: cell.width, height: cell.height } : undefined;
}

function surfaceOf(term: Terminal, fit: FitAddon, element: HTMLElement): TerminalSurface {
  // The cell at the normal font, taken while the normal font is on. It is not computed back from a smaller font:
  // cells do not shrink exactly in step, and the zoom would then swing between two sizes (#66).
  let normalCell: { width: number; height: number } | undefined;
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
    setFontSize: (size) => {
      term.options.fontSize = size;
    },
    measure: () => {
      const current = cellOf(term);
      if (term.options.fontSize === NORMAL_FONT_SIZE) normalCell = current ?? normalCell;
      if (!normalCell || !current) return undefined;
      // Like the fit addon: the computed size of the element that holds the terminal, less the scroll bar.
      const style = window.getComputedStyle(element);
      const width = Number.parseFloat(style.width) - SCROLL_BAR_PX;
      const height = Number.parseFloat(style.height);
      if (!(width > 0 && height > 0)) return undefined;
      return { area: { width, height }, cell: normalCell, current };
    },
    onData: (listener) => {
      const subscription = term.onData(listener);
      return () => subscription.dispose();
    },
    onKey: (handler) => term.attachCustomKeyEventHandler(handler),
    getSelection: () => term.getSelection(),
    paste: (text) => term.paste(text),
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
  /** Hands the controller to the window (for "Eingabe übernehmen", paste); undefined when the view goes. */
  onController: (controller: TerminalController | undefined) => void;
  /** A bound key was pressed in the terminal (keymap.ts); the window runs the command. */
  commands: KeyCommands;
  /** Right click on the pane: paste (the window decides whether this view may). */
  onContextPaste?: () => void;
}

export function TerminalView({
  api,
  sessionId,
  active,
  focusSignal,
  onStatus,
  onController,
  commands,
  onContextPaste,
}: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const pressed = useRef<{ x: number; y: number }>(undefined);
  const terminal = useRef<Terminal>(undefined);
  const controller = useRef<TerminalController>(undefined);
  // The callbacks of the parent change on every render; the view must not attach again for that.
  const callbacks = useRef({ onStatus, onController, commands });
  callbacks.current = { onStatus, onController, commands };
  const activeNow = useRef(active);
  activeNow.current = active;
  const [status, setStatus] = useState<ViewStatus>();

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const term = new Terminal({
      fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
      fontSize: NORMAL_FONT_SIZE,
      scrollback: 5_000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    terminal.current = term;
    const current = new TerminalController(
      api,
      surfaceOf(term, fit, element),
      (next) => {
        setStatus(next);
        callbacks.current.onStatus(next);
      },
      {
        commands: {
          applies: (command) => callbacks.current.commands.applies(command),
          run: (command) => callbacks.current.commands.run(command),
        },
      },
    );
    controller.current = current;
    callbacks.current.onController(current);
    void current.open(sessionId);
    const observer = new ResizeObserver(() => current.layoutChanged());
    observer.observe(element);
    if (activeNow.current) term.focus();
    return () => {
      observer.disconnect();
      terminal.current = undefined;
      controller.current = undefined;
      callbacks.current.onController(undefined);
      callbacks.current.onStatus(undefined);
      void current.dispose();
      term.dispose();
    };
  }, [api, sessionId]);

  useEffect(() => {
    if (active) terminal.current?.focus();
  }, [active, focusSignal]);

  // A reader shows the writer's grid, zoomed out to fit (#66) and clipped below the minimum font, dimmed around
  // it (ADR 0006). The frame lies on xterm's screen element and follows its size (grid, font, cell size).
  const reader = status?.role === "reader";
  // claimWriter never rejects; a refusal arrives as the error of the view status. The terminal keeps the focus.
  const takeInput = (): void => {
    void controller.current?.claimWriter();
    terminal.current?.focus();
  };
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
        // A single click only made the pane active (on press); a double click into a reader takes the input (#66).
        // A double click on the bar's button is the button's, not a second claim.
        if (event.target instanceof Element && event.target.closest(".reader-bar")) return;
        const up = { x: event.clientX, y: event.clientY, detail: event.detail };
        if (event.button === 0 && takesInput(status?.role, down, up)) takeInput();
      }}
      onContextMenu={(event) => {
        // A program that tracks the mouse (vim, htop) gets the right click; Shift forces the paste, like in xterm.
        if (terminal.current?.modes.mouseTrackingMode !== "none" && !event.shiftKey) return;
        event.preventDefault();
        onContextPaste?.();
      }}
    >
      <div className="terminal-view" ref={host} />
      {reader && frame && <div className="reader-frame" style={frame} />}
      {reader && (
        <div className="reader-bar">
          {status.size && (
            <span className="reader-hint" data-hint="writer-size">
              Größe des Schreibers: {status.size.cols}×{status.size.rows}
            </span>
          )}
          <button
            className="reader-bar__button"
            type="button"
            data-action="take-input"
            title="Eingabe übernehmen (oder Doppelklick ins Pane): dieses Pane schreibt und bestimmt die Größe"
            onClick={takeInput}
          >
            Eingabe übernehmen
          </button>
        </div>
      )}
    </div>
  );
}
