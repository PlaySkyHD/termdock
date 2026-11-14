// One terminal view of one session (ADR 0003, ADR 0006): snapshot, live output, writer and readers.
// Free of DOM and React; `TerminalView.tsx` connects it to xterm.js, split panes (#27) reuse it per pane.
import type { SessionId, TerminalSize, ViewId } from "@termdock/protocol";
import type { BridgeEvent, TermdockApi } from "../shared/bridge.js";
import { handleKey } from "./keymap.js";
import type { KeyCommands, KeyLike } from "./keymap.js";

/** The part of xterm.js and its fit addon the controller uses. */
export interface TerminalSurface {
  readonly cols: number;
  readonly rows: number;
  write(data: Uint8Array | string): void;
  reset(): void;
  resize(cols: number, rows: number): void;
  /** Draws the cursor from now on, also without focus (the snapshot carries its position, #32). */
  showCursor(): void;
  /** Size that fills the element; undefined while the element cannot be measured. */
  proposeSize(): TerminalSize | undefined;
  /** Key presses and automatic replies of the emulator; the returned function unsubscribes. */
  onData(listener: (data: string) => void): () => void;
  /**
   * Installs the handler xterm.js asks before it processes a key event (`attachCustomKeyEventHandler`): false
   * keeps the key from the terminal. Called once; a later call replaces the handler.
   */
  onKey(handler: (event: KeyEvent) => boolean): void;
  /** Selected text of the terminal, empty without a selection. */
  getSelection(): string;
  /**
   * Writes pasted text like typing: xterm.js turns line breaks into CR and wraps the text in the bracketed
   * paste markers when the application asked for them (`ESC [ ? 2004 h`). The result arrives through `onData`.
   */
  paste(text: string): void;
}

/** A key event as xterm.js hands it to the custom handler. */
export type KeyEvent = KeyLike & { preventDefault(): void };

export type ViewRole = "connecting" | "writer" | "reader" | "closed" | "error";

export interface ViewStatus {
  role: ViewRole;
  /** Size of the session's terminal, set by the writer. */
  size?: TerminalSize;
  error?: string;
}

/** Delay between a change of the element and the fit; bounds resizes while a divider is dragged (#27). */
export const LAYOUT_DELAY_MS = 60;

export interface ControllerOptions {
  /** Runs `run` once after the layout delay; the returned function cancels it. Tests pass a manual one. */
  scheduleLayout?: (run: () => void) => () => void;
  /**
   * Commands of the key map (#28). A bound key whose command applies runs it and never reaches the shell; every
   * other key does. Without it the terminal takes all keys.
   */
  commands?: KeyCommands;
}

function delayLayout(run: () => void): () => void {
  const timer = setTimeout(run, LAYOUT_DELAY_MS);
  return () => clearTimeout(timer);
}

export class TerminalController {
  private sessionId: SessionId | undefined;
  private viewId: ViewId | undefined;
  private writerViewId: ViewId | undefined;
  private size: TerminalSize | undefined;
  private status: ViewStatus = { role: "connecting" };
  /** Output that arrives before the snapshot is shown; written right after it unless the snapshot has it. */
  private pending: Array<{ seq: number; data: Uint8Array }> | undefined = [];
  /** Output events up to this number are in the snapshot (ADR 0006). */
  private snapshotSeq = 0;
  /** The core connection ended; final, nothing is sent any more. */
  private closed = false;
  /** Set once a `writerChanged` or `resized` event has been seen; it then beats the attach answer. */
  private writerFromEvent = false;
  private sizeFromEvent = false;
  private disposed = false;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly scheduleLayout: (run: () => void) => () => void;
  /** Set while a fit after a change of the element is planned. */
  private cancelLayout: (() => void) | undefined;

  constructor(
    private readonly api: TermdockApi,
    private readonly surface: TerminalSurface,
    private readonly onStatus: (status: ViewStatus) => void,
    options: ControllerOptions = {},
  ) {
    this.scheduleLayout = options.scheduleLayout ?? delayLayout;
    const { commands } = options;
    if (commands) this.surface.onKey((event) => handleKey(event, commands));
  }

  /** Text of the terminal's selection (a reader has one too). */
  selectedText(): string {
    return this.surface.getSelection();
  }

  /** Only the writing view takes input (ADR 0003), so only it may paste. */
  canPaste(): boolean {
    return this.isWriter();
  }

  /**
   * Pastes into the session as typed input. Refuses (false) in a reader, before the view is attached, after the
   * core is gone and for an empty text. The terminal decides the form: line breaks as CR, bracketed paste when
   * the application asked for it; the data then takes the same way as typing, through `onData`.
   */
  paste(text: string): boolean {
    if (text === "" || !this.canPaste()) return false;
    this.surface.paste(text);
    return true;
  }

  /** Attaches a new view to the session and shows it. Subscribes first, so no output is lost. */
  async open(sessionId: SessionId): Promise<void> {
    this.sessionId = sessionId;
    this.unsubscribe.push(this.api.onEvent((event) => this.onEvent(event)));
    this.unsubscribe.push(
      this.surface.onData((data) => {
        // Readers send nothing, also no automatic replies of xterm.js (ADR 0003).
        if (this.isWriter() && this.viewId !== undefined)
          void this.api.input(this.viewId, data).catch(() => {});
      }),
    );
    const wanted = this.surface.proposeSize() ?? { cols: this.surface.cols, rows: this.surface.rows };
    let view;
    try {
      view = await this.api.attach(sessionId, wanted);
    } catch (error) {
      // Without a view nothing may be buffered or sent any more.
      this.stopListening();
      this.pending = undefined;
      if (!this.disposed)
        this.setStatus({ role: "error", error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (this.disposed) {
      // Disposed while the core attached: give the view back at once.
      await this.api.detach(view.viewId).catch(() => {});
      return;
    }
    this.viewId = view.viewId;
    // Events travel apart from the attach answer; one that arrived meanwhile is at least as new as the answer.
    if (!this.writerFromEvent) this.writerViewId = view.writerViewId;
    if (!this.sizeFromEvent) this.size = view.size;
    // The snapshot is the screen in the session's size; in any other size its lines would wrap or scroll.
    if (view.size.cols !== this.surface.cols || view.size.rows !== this.surface.rows)
      this.surface.resize(view.size.cols, view.size.rows);
    this.surface.reset();
    // The snapshot begins with the terminal modes of the session (mouse, cursor keys, bracketed paste, issue #42),
    // so this view takes input like one that saw all output.
    this.surface.write(trimTrailingBlankLines(view.snapshot));
    // A reader pane may never get the focus; it still shows where the writer's cursor is.
    this.surface.showCursor();
    this.snapshotSeq = view.outputSeq;
    for (const { seq, data } of this.pending ?? []) if (seq > this.snapshotSeq) this.surface.write(data);
    this.pending = undefined;
    if (this.closed) return;
    this.applyRole();
  }

  /** Asks the core for the writer; the role changes when `writerChanged` arrives. A refusal shows in the status. */
  async claimWriter(): Promise<void> {
    if (this.viewId === undefined || this.closed) return;
    if (this.status.error !== undefined) {
      const { error: _previous, ...rest } = this.status;
      this.setStatus(rest);
    }
    try {
      await this.api.claimWriter(this.viewId);
    } catch (error) {
      if (!this.disposed)
        this.setStatus({ ...this.status, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * The element changed size. After a short delay the writer fits and sends its size, once for all changes in
   * that time (no storm of resizes while a divider is dragged); a reader stays at the writer's size.
   */
  layoutChanged(): void {
    if (this.cancelLayout || this.disposed) return;
    this.cancelLayout = this.scheduleLayout(() => {
      this.cancelLayout = undefined;
      if (!this.disposed && this.isWriter()) this.fitAsWriter();
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelLayout?.();
    this.cancelLayout = undefined;
    this.stopListening();
    const viewId = this.viewId;
    this.viewId = undefined;
    if (viewId !== undefined) await this.api.detach(viewId).catch(() => {});
  }

  private stopListening(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  private onEvent(event: BridgeEvent): void {
    if (event.kind === "coreClosed") {
      this.closed = true;
      this.setStatus({ ...this.status, role: "closed" });
      return;
    }
    if (event.kind === "sessionCreated" || event.sessionId !== this.sessionId) return;
    switch (event.kind) {
      case "output":
        if (this.pending) this.pending.push({ seq: event.seq, data: event.data });
        else if (event.seq > this.snapshotSeq) this.surface.write(event.data);
        return;
      case "resized":
        this.size = event.size;
        this.sizeFromEvent = true;
        if (this.viewId !== undefined && !this.closed && !this.isWriter()) this.showWriterSize();
        return;
      case "writerChanged":
        this.writerViewId = event.writerViewId;
        this.writerFromEvent = true;
        if (this.viewId !== undefined) this.applyRole();
        return;
    }
  }

  private isWriter(): boolean {
    return !this.closed && this.viewId !== undefined && this.viewId === this.writerViewId;
  }

  private applyRole(): void {
    // `closed` is final: no role from later events, no resize.
    if (this.closed) return;
    if (this.isWriter()) this.fitAsWriter();
    else this.showWriterSize();
  }

  private fitAsWriter(): void {
    const fit = this.surface.proposeSize();
    if (fit && (fit.cols !== this.surface.cols || fit.rows !== this.surface.rows))
      this.surface.resize(fit.cols, fit.rows);
    const size = { cols: this.surface.cols, rows: this.surface.rows };
    const changed = this.status.role !== "writer" || !sameSize(size, this.size);
    this.size = size;
    if (changed && this.viewId !== undefined) void this.api.resize(this.viewId, size).catch(() => {});
    this.setStatus({ ...this.status, role: "writer", size });
  }

  /** Readers show the terminal in the writer's size; a smaller element clips it (ADR 0006). */
  private showWriterSize(): void {
    const size = this.size;
    if (size && (size.cols !== this.surface.cols || size.rows !== this.surface.rows))
      this.surface.resize(size.cols, size.rows);
    this.setStatus({ ...this.status, role: "reader", ...(size ? { size } : {}) });
  }

  private setStatus(status: ViewStatus): void {
    this.status = status;
    this.onStatus(status);
  }
}

/**
 * The snapshot carries no cursor position (protocol 1.0), so the cursor ends where the data ends. A WSL
 * snapshot lists every row of the pane; without its blank rows at the end the cursor stays behind the last
 * written text, which for a shell is the prompt. Output the core appended during the capture may follow the
 * blank rows; its control sequences (CSI) stay, only line breaks, spaces and tabs go.
 */
function trimTrailingBlankLines(snapshot: Uint8Array): string {
  // From the first line break after the last text: nothing but whitespace and CSI sequences.
  return new TextDecoder()
    .decode(snapshot)
    .replace(TRAILING_BLANK, (tail) => tail.match(CSI)?.join("") ?? "");
}

/* eslint-disable no-control-regex */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const TRAILING_BLANK = /\r?\n(?:[\r\n \t]|\x1b\[[0-?]*[ -/]*[@-~])*$/;
/* eslint-enable no-control-regex */

function sameSize(a: TerminalSize, b: TerminalSize | undefined): boolean {
  return b !== undefined && a.cols === b.cols && a.rows === b.rows;
}
