// Connects the store of a window to the layout the main process keeps (#29, ADR 0006): takes over the window it
// holds (restore, also after a reload of the page) and reports every later change of the window. Free of React and
// Electron.
import type { LayoutWindow } from "@termdock/protocol";
import type { TermdockApi } from "../shared/bridge.js";
import { windowPart } from "../shared/layout-mapping.js";
import type { UiStore } from "./ui-store.js";

type Api = Pick<TermdockApi, "windowLayout" | "reportLayout">;

export interface LayoutSync {
  /** Settles when the window is loaded into the store (or loading has failed); never rejects. */
  ready: Promise<void>;
  dispose(): void;
}

/**
 * Asks for the window first and reports only afterwards: the start state of the store would otherwise replace the
 * stored layout. When the window cannot be loaded nothing is reported at all.
 */
export function startLayoutSync(store: UiStore, api: Api, onError: (message: string) => void): LayoutSync {
  let disposed = false;
  let off: (() => void) | undefined;

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
    let reported = store.getState().window;
    off = store.subscribe(() => {
      const current = store.getState().window;
      // Sessions, the core status and the like change the store too; only the window is part of the layout.
      if (current === reported) return;
      reported = current;
      api.reportLayout(windowPart(current)).catch((error: unknown) => onError(messageOf(error)));
    });
  })();

  return {
    ready,
    dispose: () => {
      disposed = true;
      off?.();
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
