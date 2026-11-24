// The quit of the app (issue #60) without Electron: whether to ask, the dialog, the last layout save, the end of the
// sessions, and the order of it all. Electron (windows, `app`) and the core connection come in as functions, so
// the order, "Abbrechen", a second quit and the error paths run in tests.
import { DEFAULT_SETTINGS } from "@termdock/protocol";
import type { BackendKind, SessionState, SettingsPatch } from "@termdock/protocol";
import { countActive, countActiveWindows, outcomeOfAnswer, planQuit } from "../shared/quit-decision.js";
import type { QuitAnswer, QuitReason, QuitSettings } from "../shared/quit-decision.js";

/** `undefined`: the user cancelled, the app stays. */
export type QuitDecision = { stopSessions: boolean } | undefined;

export interface DecideDeps {
  /** The sessions of the core; `undefined` when the core did not answer (the dep has logged why). */
  listSessions(): Promise<readonly { state: SessionState; launch?: { backend: BackendKind } }[] | undefined>;
  /** The settings; `undefined` when the core did not answer (a core of protocol 1.2 has none). */
  getSettings(): Promise<QuitSettings | undefined>;
  saveSettings(patch: SettingsPatch): Promise<void>;
  /**
   * Shows the dialog and returns the answer; `undefined` when there is no window to ask in. `windowsSessions`: how
   * many of the active ones run a Windows shell, which ends with the core (#65).
   */
  ask(activeSessions: number, windowsSessions: number): Promise<QuitAnswer | undefined>;
  log(text: string): void;
}

/**
 * Whether and how the app quits: `undefined` when the user cancels. Counts the sessions that run, reads the
 * settings, and only when the plan says "ask" opens the dialog. A choice with "Nicht mehr fragen" is stored before
 * the quit goes on. Never blocks the quit on a core that cannot answer: then the sessions are kept.
 */
export async function decideQuit(deps: DecideDeps, reason: QuitReason): Promise<QuitDecision> {
  const sessions = await deps.listSessions();
  if (sessions === undefined) return { stopSessions: false };
  // A core without settings (protocol 1.2) asks like the defaults.
  const settings = (await deps.getSettings()) ?? DEFAULT_SETTINGS;
  const activeSessions = countActive(sessions);
  const plan = planQuit({ reason, activeSessions, settings });
  if (plan.kind === "quit") return { stopSessions: plan.stopSessions };
  const answer = await deps.ask(activeSessions, countActiveWindows(sessions));
  if (answer === undefined) return { stopSessions: false };
  const outcome = outcomeOfAnswer(answer);
  if (outcome.kind === "cancel") return undefined;
  if (outcome.remember) {
    await deps
      .saveSettings(outcome.remember)
      .catch((error: unknown) => deps.log(`settings.set: ${messageOf(error)}`));
  }
  return { stopSessions: outcome.stopSessions };
}

export interface QuitFlowDeps {
  decide(reason: QuitReason): Promise<QuitDecision>;
  /** Every open window stays in the layout with its current geometry. */
  retainAll(): void;
  /** The last layout save, bounded by the caller. */
  flush(): Promise<void>;
  /** `core.shutdown { stopSessions: true }`. */
  shutdownCore(): Promise<void>;
  /** `core.shutdown { stopSessions: false }`: the core ends, its tmux sessions and WSL keepalive stay (#136). */
  releaseCore(): Promise<void>;
  /** True while connected to a core: not during a restart and not after the restarts gave up (#130). */
  coreConnected(): boolean;
  /** `app.relaunch()`: the app starts again after it quits (#136, a failed start of the installer). */
  relaunch(): void;
  closeClient(): Promise<void>;
  /** `app.quit()`. */
  quit(): void;
  log(text: string): void;
}

export class QuitFlow {
  private flow: Promise<void> | undefined;
  private finishing: Promise<void> | undefined;
  private stopWanted = false;
  private shutdownDone = false;
  private retained = false;
  private ready = false;
  /** An update install owns the end of the app (#136): no question, no `app.quit()` of this flow. */
  private updating = false;

  constructor(private readonly deps: QuitFlowDeps) {}

  /** True once the connection is closed and `app.quit()` may go through. */
  get quitReady(): boolean {
    return this.ready;
  }

  /**
   * `close` of a window. For the last window of a quit that is not decided yet, the close is held back and the
   * quit flow starts; returns true then (the caller prevents the close).
   */
  interceptClose(lastWindow: boolean): boolean {
    if (this.retained || !lastWindow) return false;
    void this.request();
    return true;
  }

  /** `before-quit` (menu, Ctrl+Q): held back once, until the flow has decided; then it goes through. */
  beforeQuit(preventDefault: () => void): void {
    if (this.ready) {
      this.retain();
      return;
    }
    preventDefault();
    // The update install quits on its own once the core is released.
    if (this.updating) return;
    void this.request();
  }

  /** `window-all-closed` without a decision (a window went away another way): keep the sessions. */
  windowsClosed(): void {
    if (this.updating) return;
    this.finishAndQuit(false);
  }

  /**
   * "Jetzt neu starten" of the update dialog (#136): like a quit that keeps the sessions, but the core is ended with
   * `core.shutdown { stopSessions: false }` (the installer must replace its files; tmux sessions and the WSL
   * keepalive stay, Windows shells end with it), then `install` starts the installer and the app quits. The core is
   * gone at that point, so the app quits also when the installer cannot start, and then starts itself again; the next
   * start brings a new core and offers the update again. False, doing nothing, while a quit or an install already
   * runs or while the core is not connected.
   */
  installUpdate(install: () => boolean): boolean {
    if (this.updating || this.flow !== undefined || this.finishing !== undefined || this.retained)
      return false;
    // During a restart of the core (#130) `core.shutdown` would reach nobody, and the core that the restart brings
    // up would run on until the installer kills it, perhaps while it takes the WSL keepalive over. Not now.
    if (!this.deps.coreConnected()) {
      this.deps.log("update install: the core is not connected");
      return false;
    }
    this.updating = true;
    this.retain();
    this.finishing = (async () => {
      await this.deps.flush().catch((error: unknown) => this.deps.log(`layout.save: ${messageOf(error)}`));
      this.shutdownDone = true;
      await this.deps
        .releaseCore()
        .catch((error: unknown) => this.deps.log(`core.shutdown: ${messageOf(error)}`));
      await this.deps.closeClient().catch(() => {});
    })();
    void this.finishing.finally(() => {
      this.ready = true;
      let started = false;
      try {
        started = install();
      } catch (error) {
        this.deps.log(`update install: ${messageOf(error)}`);
      }
      // The core is gone: the app quits either way. Without a running installer (which starts the new version) it
      // starts itself again, so the user does not see a crash; the next start offers the update again.
      if (!started) {
        this.deps.log("update install: the installer did not start, the app restarts");
        this.deps.relaunch();
      }
      this.deps.quit();
    });
    return true;
  }

  /**
   * Windows logoff or shutdown: never asks, keeps the sessions, saves the layout. The system ends the session, so
   * there is no `app.quit()`. Goes through `planQuit` like every quit; count and settings do not matter here.
   */
  sessionEnd(): void {
    const plan = planQuit({
      reason: "session-end",
      activeSessions: 1,
      settings: { confirmQuitWhileRunning: true },
    });
    this.retain();
    void this.finish(plan.kind === "quit" && plan.stopSessions);
  }

  /**
   * The quit of the user. One at a time. Stays set once the quit is decided (save and shutdown still run), so a
   * second request cannot start a second decision on a closing connection; only a cancelled quit frees it.
   */
  request(): Promise<void> {
    if (this.updating) return this.finishing ?? Promise.resolve();
    this.flow ??= (async () => {
      let quitting = true;
      try {
        const decision = await this.deps.decide("user");
        if (decision === undefined) {
          quitting = false; // cancelled: nothing changed, the windows stay
          return;
        }
        this.retain();
        this.finishAndQuit(decision.stopSessions);
      } catch (error) {
        // Never trap the user: a failed decision quits like before (keep the sessions).
        this.deps.log(`quit decision: ${messageOf(error)}`);
        this.retain();
        this.finishAndQuit(false);
      } finally {
        if (!quitting) this.flow = undefined;
      }
    })();
    return this.flow;
  }

  private retain(): void {
    this.retained = true;
    this.deps.retainAll();
  }

  private finishAndQuit(stopSessions: boolean): void {
    void this.finish(stopSessions).finally(() => {
      this.ready = true;
      this.deps.quit();
    });
  }

  /**
   * The last save, then (with `stopSessions`) the end of the sessions, then the end of the connection; once,
   * however often it is asked for. A later call that wants the sessions stopped still counts as long as the
   * shutdown has not been sent: the wish is read after the save, not when the first call came.
   */
  private finish(stopSessions: boolean): Promise<void> {
    if (stopSessions) this.stopWanted = true;
    this.finishing ??= (async () => {
      await this.deps.flush().catch((error: unknown) => this.deps.log(`layout.save: ${messageOf(error)}`));
      await this.shutdownIfWanted();
      await this.deps.closeClient().catch(() => {});
    })();
    // The connection is already closing: a late wish cannot be sent any more, but it must not vanish silently.
    if (stopSessions && !this.shutdownDone) {
      void this.finishing.then(() => {
        if (!this.shutdownDone)
          this.deps.log("stopSessions came too late: the connection was already closed");
      });
    }
    return this.finishing;
  }

  private async shutdownIfWanted(): Promise<void> {
    if (!this.stopWanted) return;
    this.shutdownDone = true;
    await this.deps
      .shutdownCore()
      .catch((error: unknown) => this.deps.log(`core.shutdown: ${messageOf(error)}`));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
