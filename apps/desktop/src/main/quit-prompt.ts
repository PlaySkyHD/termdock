// The quit dialog as the main process sees it (issue #60): asks one window, waits for its answer, and turns a
// vanished window into "cancel". Free of Electron so it runs in tests.
import { randomUUID } from "node:crypto";
import { IpcError } from "@termdock/core";
import type { BridgeEvent } from "../shared/bridge.js";
import type { QuitAnswer } from "../shared/quit-decision.js";

interface Pending {
  requestId: string;
  windowId: number;
  activeSessions: number;
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
   * reached cancels at once, so the quit never waits for a dialog nobody sees.
   */
  ask(windowId: number, activeSessions: number): Promise<QuitAnswer> {
    if (this.pending) return this.pending.promise;
    const requestId = this.newId();
    let resolve: (answer: QuitAnswer) => void = () => {};
    const promise = new Promise<QuitAnswer>((done) => (resolve = done));
    this.pending = { requestId, windowId, resolve, promise, activeSessions };
    if (!this.send(windowId, { kind: "quitRequested", requestId, activeSessions })) this.windowGone(windowId);
    return promise;
  }

  /**
   * The page of the window finished loading: a question that was sent while it loaded (before the renderer
   * listened) goes out again. The renderer takes a repeated question idempotently.
   */
  resend(windowId: number): void {
    const pending = this.pending;
    if (pending?.windowId !== windowId) return;
    const { requestId, activeSessions } = pending;
    this.send(windowId, { kind: "quitRequested", requestId, activeSessions });
  }

  /** The answer of a renderer. Only the asked window may answer the open question. */
  answer(windowId: number, requestId: string, answer: QuitAnswer): void {
    const pending = this.pending;
    if (!pending || pending.windowId !== windowId || pending.requestId !== requestId)
      throw new IpcError("not_found", "There is no open quit question for this window");
    this.pending = undefined;
    pending.resolve(answer);
  }

  /** The window that was asked is gone (closed, reloaded, crashed): nobody can answer, so the quit is cancelled. */
  windowGone(windowId: number): void {
    const pending = this.pending;
    if (!pending || pending.windowId !== windowId) return;
    this.pending = undefined;
    pending.resolve(CANCEL);
  }
}
