// Connects the store of a window to the layout the main process keeps (#29, ADR 0006): takes over the window it
// holds (restore, also after a reload of the page) and reports the later changes of the window. Free of React and
// Electron.
import type { LayoutWindow } from "@termdock/protocol";
import type { TermdockApi } from "../shared/bridge.js";
import { windowPart } from "../shared/layout-mapping.js";
import { messageOf } from "../shared/message-of.js";
import type { UiStore } from "./ui-store.js";

type Api = Pick<TermdockApi, "windowLayout" | "reportLayout">;

/** Changes within this time go out as one report with the latest state (dragging a divider changes it often). */
export const REPORT_DELAY_MS = 50;

export interface LayoutSyncOptions {
  /** Runs `run` after `ms`; returns the function that cancels it. */
  schedule?(run: () => void, ms: number): () => void;
  delayMs?: number;
}

export interface LayoutSync {
  /** Settles when the window is loaded into the store (or loading has failed); never rejects. */
  ready: Promise<void>;
  /** Sends a report that is still waiting for its delay, for example when the page goes away. */
  flush(): void;
  dispose(): void;
}

const defaultSchedule = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/**
 * Asks for the window first and reports only afterwards: the start state of the store would otherwise replace the
 * stored layout. When the window cannot be loaded nothing is reported at all. Reports are bundled: at most one per
 * `delayMs`, always carrying the latest state of the window.
 */
export function startLayoutSync(
  store: UiStore,
  api: Api,
  onError: (message: string) => void,
  options: LayoutSyncOptions = {},
): LayoutSync {
  const schedule = options.schedule ?? defaultSchedule;
  const delayMs = options.delayMs ?? REPORT_DELAY_MS;
  let disposed = false;
  let off: (() => void) | undefined;
  let cancelPending: (() => void) | undefined;
  /** The window the main process knows (loaded or reported last). */
  let reported: LayoutWindow | undefined;

  const send = (): void => {
    cancelPending?.();
    cancelPending = undefined;
    const current = store.getState().window;
    if (current === reported) return;
    reported = current;
    api.reportLayout(windowPart(current)).catch((error: unknown) => onError(messageOf(error)));
  };

  const ready = (async () => {
    let window: LayoutWindow;
    try {
      window = await api.windowLayout();
    } catch (error) {
      onError(messageOf(error));
      return;
    }
    // A disposed sync must not overwrite what a newer one has loaded (StrictMode, reload).
    if (disposed) return;
    store.loadWindow(window);
    reported = store.getState().window;
    off = store.subscribe(() => {
      // Sessions, the core status and the like change the store too; only the window is part of the layout.
      if (store.getState().window === reported || cancelPending) return;
      cancelPending = schedule(send, delayMs);
    });
  })();

  return {
    ready,
    flush: send,
    dispose: () => {
      disposed = true;
      off?.();
      cancelPending?.();
      cancelPending = undefined;
    },
  };
}
