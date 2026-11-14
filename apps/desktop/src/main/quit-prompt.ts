// The quit dialog as the main process sees it (issue #60): asks one window, waits for its answer, and turns a
// vanished or unresponsive window into "cancel". Free of Electron so it runs in tests.
import { randomUUID } from "node:crypto";
import { IpcError } from "@termdock/core";
import type { BridgeEvent } from "../shared/bridge.js";
import type { QuitAnswer } from "../shared/quit-decision.js";

/** The question goes out again this often until the window confirms that the dialog is shown. */
export const QUIT_ASK_RETRY_MS = 500;
/** Without a confirmation after this long the question is cancelled: the quit never waits for a dialog nobody sees. */
export const QUIT_ASK_ACK_TIMEOUT_MS = 5_000;

interface Pending {
  requestId: string;
  windowId: number;
  activeSessions: number;
  acked: boolean;
  timers: NodeJS.Timeout[];
  resolve: (answer: QuitAnswer) => void;
  promise: Promise<QuitAnswer>;
}

const CANCEL: QuitAnswer = { choice: "cancel", remember: false };

export class QuitPrompt {
  private pending: Pending | undefined;

  constructor(
    /** Returns false when the window is unknown (gone, not registered): nobody can answer. */
    private readonly send: (windowId: number, event: BridgeEvent) => boolean,
    private readonly newId: () => string = randomUUID,
  ) {}

  /**
   * Asks the window. While a question is open, a second call gets the answer of the first. A window that cannot be
   * reached cancels at once. One that does not confirm (`ack`) within `QUIT_ASK_ACK_TIMEOUT_MS`, for example
   * because its renderer has not listened yet or hangs, cancels too (the app stays open, nothing is stopped, the
   * user can quit again). The question is sent again every `QUIT_ASK_RETRY_MS` until then. Once the dialog is
   * shown there is no time limit: the user answers when ready.
   */
  ask(windowId: number, activeSessions: number): Promise<QuitAnswer> {
    if (this.pending) return this.pending.promise;
    const requestId = this.newId();
    let resolve: (answer: QuitAnswer) => void = () => {};
    const promise = new Promise<QuitAnswer>((done) => (resolve = done));
    const pending: Pending = {
      requestId,
      windowId,
      activeSessions,
      acked: false,
      timers: [],
      resolve,
      promise,
    };
    this.pending = pending;
    if (!this.send(windowId, { kind: "quitRequested", requestId, activeSessions })) {
      this.windowGone(windowId);
      return promise;
    }
    pending.timers.push(
      setInterval(() => this.resend(windowId), QUIT_ASK_RETRY_MS),
      setTimeout(() => {
        if (this.pending === pending && !pending.acked) this.settle(pending, CANCEL);
      }, QUIT_ASK_ACK_TIMEOUT_MS),
    );
    return promise;
  }

  /**
   * Sends the open question again if its window has not confirmed it yet (the page finished loading, or the retry
   * timer). The renderer takes a repeated question idempotently.
   */
  resend(windowId: number): void {
    const pending = this.pending;
    if (pending?.windowId !== windowId || pending.acked) return;
    const { requestId, activeSessions } = pending;
    this.send(windowId, { kind: "quitRequested", requestId, activeSessions });
  }

  /** The window shows the dialog for this question: no more retries, no more timeout. */
  ack(windowId: number, requestId: string): void {
    const pending = this.pending;
    if (!pending || pending.windowId !== windowId || pending.requestId !== requestId)
      throw new IpcError("not_found", "There is no open quit question for this window");
    pending.acked = true;
    this.stopTimers(pending);
  }

  /** The answer of a renderer. Only the asked window may answer the open question. */
  answer(windowId: number, requestId: string, answer: QuitAnswer): void {
    const pending = this.pending;
    if (!pending || pending.windowId !== windowId || pending.requestId !== requestId)
      throw new IpcError("not_found", "There is no open quit question for this window");
    this.settle(pending, answer);
  }

  /** The window that was asked is gone (closed, reloaded, crashed): nobody can answer, so the quit is cancelled. */
  windowGone(windowId: number): void {
    const pending = this.pending;
    if (!pending || pending.windowId !== windowId) return;
    this.settle(pending, CANCEL);
  }

  private settle(pending: Pending, answer: QuitAnswer): void {
    this.pending = undefined;
    this.stopTimers(pending);
    pending.resolve(answer);
  }

  private stopTimers(pending: Pending): void {
    for (const timer of pending.timers.splice(0)) {
      clearInterval(timer);
      clearTimeout(timer);
    }
  }
}
