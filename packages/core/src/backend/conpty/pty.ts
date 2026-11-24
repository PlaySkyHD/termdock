// PtyHandle around a node-pty ConPTY process: the tmux client of a WSL session or the shell of a Windows session
// (ADR 0003, ADR 0008).
import type { SessionWarning, TerminalSize } from "@termdock/protocol";
import type { Disposable, PtyHandle } from "../types.js";

/** How a PTY process ended. `lost`: the core closed it because its output was lost (ADR 0008), not by itself. */
export interface PtyProcessExit {
  exitCode: number;
  lost?: boolean;
}

/** The part of node-pty's `IPty` the backends use. */
export interface PtyProcess {
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** After `kill`: resolves once the process ended (or the wait for it gave up). Without it, `kill` counts as done. */
  closed?(): Promise<void>;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: PtyProcessExit) => void): Disposable;
}

type ExitEvent = { exitCode?: number };

/** DA1 query of the bundled ConPTY (`ESC [ c` or `ESC [ 0 c`). */
// eslint-disable-next-line no-control-regex -- the escape character is the point of this pattern
const DA1_QUERY = /\x1b\[0?c/;
/** Any primary DA answer (`ESC [ ? … c`), as a view's terminal emulator sends it. */
// eslint-disable-next-line no-control-regex -- the escape character is the point of this pattern
const DA1_ANSWER = /\x1b\[\?[\d;]*c/;
/** VT100 with advanced video option, as xterm.js answers. */
const DA1_REPLY = "\x1b[?1;2c";
const encoder = new TextEncoder();

/**
 * One ConPTY process. Answers the first DA1 query of the bundled ConPTY itself and removes it from the output, so the
 * start does not wait up to 3 s for a view; skipped once a DA1 answer came from outside. No view sees the removed
 * query, so none answers it twice. When the process ends, `resolveEnd` decides what that means for the session: WSL
 * asks tmux (program ended with exit code, or only the client was lost), Windows takes the exit code of the shell.
 */
export class ConptyPty implements PtyHandle {
  /** Set by the backend's `start` (issue #113). */
  warnings: readonly SessionWarning[] | undefined;
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly exitListeners = new Set<(event: ExitEvent) => void>();
  private readonly subscriptions: Disposable[];
  private answerDa1 = true;
  private ended = false;
  private disposed = false;
  private markReported: () => void = () => {};
  private readonly reported = new Promise<void>((resolve) => (this.markReported = resolve));

  constructor(
    private readonly process: PtyProcess,
    private readonly resolveEnd: (exit: PtyProcessExit) => Promise<ExitEvent>,
  ) {
    this.subscriptions = [
      process.onData((data) => this.handleData(data)),
      process.onExit((exit) => this.handleExit(exit)),
    ];
  }

  write(data: Uint8Array | string): void {
    if (this.ended || this.disposed) return;
    const payload = typeof data === "string" ? data : Buffer.from(data);
    // A view already answered DA1 itself; typed input alone does not count (it would delay the start by 3 s).
    if (this.answerDa1 && DA1_ANSWER.test(payload.toString())) this.answerDa1 = false;
    this.process.write(payload);
  }

  resize(size: TerminalSize): void {
    if (this.ended || this.disposed) return;
    this.process.resize(size.cols, size.rows);
  }

  onData(listener: (data: Uint8Array) => void): Disposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: ExitEvent) => void): Disposable {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  /** Closes the process (WSL: the tmux client only, the session keeps running; Windows: the shell). Reports no end. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dataListeners.clear();
    this.exitListeners.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
    if (!this.ended) this.process.kill();
    this.markReported();
  }

  /** After `dispose`: resolves once the process ended (#160); at once before `dispose`. */
  closed(): Promise<void> {
    return this.disposed ? (this.process.closed?.() ?? Promise.resolve()) : Promise.resolve();
  }

  /**
   * Resolves once the end of the process has been reported to the exit listeners, or once the handle was disposed
   * without reporting it. A backend that ends the process itself (Windows `kill`) waits for it, so the registry has
   * the exit code before the kill returns.
   */
  endReported(): Promise<void> {
    return this.reported;
  }

  private handleData(data: string): void {
    if (this.disposed) return;
    let text = data;
    if (this.answerDa1 && DA1_QUERY.test(text)) {
      this.answerDa1 = false;
      text = text.replace(DA1_QUERY, "");
      this.process.write(DA1_REPLY);
      if (text === "") return;
    }
    const bytes = encoder.encode(text);
    for (const listener of [...this.dataListeners]) listener(bytes);
  }

  private handleExit(exit: PtyProcessExit): void {
    if (this.ended || this.disposed) return;
    this.ended = true;
    void this.resolveEnd(exit)
      .catch((): ExitEvent => ({}))
      .then((event) => {
        if (this.disposed) return;
        for (const listener of [...this.exitListeners]) listener(event);
        this.exitListeners.clear();
        this.markReported();
      });
  }
}
