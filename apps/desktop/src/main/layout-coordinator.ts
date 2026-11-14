// The layout of all windows in the main process (#29, ADR 0006): every window reports its part (tabs, panes,
// sidebar), the main process adds position and size, bundles them into one `LayoutDocument` and saves it with
// `layout.save` after a short delay and when the app quits. Free of Electron so it runs in tests.
import { IpcError } from "@termdock/core";
import { validateLayoutDocument } from "@termdock/protocol";
import type { LayoutDocument, LayoutWindow, WindowBounds } from "@termdock/protocol";
import { toLayoutDocument, windowsFromDocument, withPart } from "../shared/layout-mapping.js";
import type { LayoutWindowPart } from "../shared/layout-mapping.js";
import { messageOf } from "../shared/message-of.js";
import type { CorePort } from "./core-connection.js";

/** What the coordinator needs of the core connection. */
export type LayoutPort = Pick<CorePort, "request">;

/** Wait after the last change before saving. */
export const SAVE_DELAY_MS = 400;
/** Longest wait after the first change, so dragging a divider does not postpone saving for ever. */
export const SAVE_MAX_WAIT_MS = 2_000;
/** Tries for one document when the revision is stale: reload the revision, save the same state again. */
const MAX_ATTEMPTS = 3;
/** Waits between the tries to read the stored layout at start. */
const LOAD_RETRY_DELAYS_MS: readonly number[] = [300, 1_000];

export interface LayoutCoordinatorOptions {
  core: LayoutPort;
  log(text: string): void;
  delayMs?: number;
  maxWaitMs?: number;
  /** Waits between the tries of `load`; the default is a few seconds in total. */
  loadRetryDelaysMs?: readonly number[];
  sleep?(ms: number): Promise<void>;
}

export interface WindowGeometry {
  bounds?: WindowBounds;
  maximized?: boolean;
}

interface Entry {
  window: LayoutWindow;
  /** The window was closed; it stays in the document (the app quits, or it was the last one). */
  closed: boolean;
}

export class LayoutCoordinator {
  /** Windows by the id of their `webContents`, in the order they were added. */
  private readonly windows = new Map<number, Entry>();
  private readonly core: LayoutPort;
  private readonly log: (text: string) => void;
  private readonly delayMs: number;
  private readonly maxWaitMs: number;
  /** Revision of the stored layout as far as known; undefined until `layout.get` has answered. */
  private revision: number | undefined;
  /** `layout.get` has answered, so what is stored is known and may be replaced. */
  private loaded = false;
  private readonly loadRetryDelaysMs: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private dirty = false;
  private timer: NodeJS.Timeout | undefined;
  private firstChange = 0;
  private running: Promise<void> | undefined;

  constructor(options: LayoutCoordinatorOptions) {
    this.core = options.core;
    this.log = options.log;
    this.delayMs = options.delayMs ?? SAVE_DELAY_MS;
    this.maxWaitMs = options.maxWaitMs ?? SAVE_MAX_WAIT_MS;
    this.loadRetryDelaysMs = options.loadRetryDelaysMs ?? LOAD_RETRY_DELAYS_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Reads the stored layout and returns its windows (none without a layout). A failing `layout.get` is retried
   * with the waits of `loadRetryDelaysMs`. When it keeps failing the app starts with a window in its start state,
   * but nothing is saved until a `layout.get` has answered, and then only if it finds no stored layout: a layout
   * that was never loaded must not be overwritten.
   */
  async load(): Promise<LayoutWindow[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        const { result } = await this.core.request("layout.get", {});
        this.revision = result.revision;
        this.loaded = true;
        return windowsFromDocument(result.layout);
      } catch (error) {
        this.log(`layout.get failed: ${messageOf(error)}`);
        const wait = this.loadRetryDelaysMs[attempt];
        if (wait === undefined) return [];
        await this.sleep(wait);
      }
    }
  }

  /** Number of windows in the document, closed ones that stay in it included. */
  size(): number {
    return this.windows.size;
  }

  /** Registers a window. A window that is not `restored` is new in the layout and gets saved. */
  addWindow(key: number, window: LayoutWindow, options: { restored?: boolean } = {}): void {
    this.windows.set(key, { window, closed: false });
    if (!options.restored) this.changed();
  }

  /** The window as the renderer shows it (id included), or undefined for an unknown window. */
  windowOf(key: number): LayoutWindow | undefined {
    return this.windows.get(key)?.window;
  }

  openWindows(): number {
    return [...this.windows.values()].filter((entry) => !entry.closed).length;
  }

  /**
   * Takes the part a renderer reports. The whole document must stay valid (limits, unique ids across windows),
   * otherwise `bad_request` and nothing changes. A window that is unknown or closed is ignored.
   */
  report(key: number, part: LayoutWindowPart): void {
    const entry = this.windows.get(key);
    if (!entry || entry.closed) return;
    const next = withPart(entry.window, part);
    const candidate = toLayoutDocument(this.windowsWith(key, next));
    const result = validateLayoutDocument(candidate);
    if (!result.ok) throw new IpcError("bad_request", result.error.message);
    entry.window = next;
    this.changed();
  }

  /** Position, size and maximization of the window as the main process reads them. */
  setGeometry(key: number, geometry: WindowGeometry): void {
    const entry = this.windows.get(key);
    if (!entry || entry.closed) return;
    const { bounds, maximized } = geometry;
    const before = entry.window;
    const next: LayoutWindow = {
      ...before,
      ...(bounds === undefined ? {} : { bounds }),
      ...(maximized === undefined ? {} : { maximized }),
    };
    if (JSON.stringify(next) === JSON.stringify(before)) return;
    entry.window = next;
    this.changed();
  }

  /**
   * The window is closed. `keep` leaves it in the layout (the app quits, or it was the last window); otherwise the
   * user closed one of several windows and it is gone from the layout.
   */
  closeWindow(key: number, options: { keep: boolean }): void {
    const entry = this.windows.get(key);
    // A window that already stays in the layout (quit, session end) has nothing more to change.
    if (!entry || (entry.closed && options.keep)) return;
    if (options.keep) entry.closed = true;
    else this.windows.delete(key);
    this.changed();
  }

  /** Saves at once if something changed and waits until the core has answered. Never rejects. */
  flush(): Promise<void> {
    this.clearTimer();
    return this.drain();
  }

  private windowsWith(key: number, replacement: LayoutWindow): LayoutWindow[] {
    return [...this.windows].map(([each, entry]) => (each === key ? replacement : entry.window));
  }

  private changed(): void {
    this.dirty = true;
    const now = Date.now();
    if (this.timer === undefined) this.firstChange = now;
    else clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.delayMs, this.firstChange + this.maxWaitMs - now));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, wait);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One save at a time; changes during a save are picked up by the same run. */
  private drain(): Promise<void> {
    if (!this.running) {
      if (!this.dirty) return Promise.resolve();
      this.running = this.run().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  private async run(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      try {
        await this.write(toLayoutDocument([...this.windows.values()].map((entry) => entry.window)));
      } catch (error) {
        // Keep the state for the next save or flush; do not loop on a core that keeps failing.
        this.dirty = true;
        this.log(`layout.save failed: ${messageOf(error)}`);
        return;
      }
    }
  }

  private async write(layout: LayoutDocument): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      if (!this.loaded) await this.checkNothingUnloaded();
      try {
        const { result } = await this.core.request("layout.save", {
          layout,
          ...(this.revision === undefined ? {} : { baseRevision: this.revision }),
        });
        this.revision = result.revision;
        return;
      } catch (error) {
        if (!(error instanceof IpcError) || error.code !== "invalid_state" || attempt >= MAX_ATTEMPTS)
          throw error;
        // Another client saved in between: the last state wins, so take its revision and save ours again.
        await this.refreshRevision();
      }
    }
  }

  private async refreshRevision(): Promise<void> {
    const { result } = await this.core.request("layout.get", {});
    this.revision = result.revision;
  }

  /**
   * The start could not read the stored layout. Saving may only begin when there is nothing stored to lose (a
   * stored layout that is unusable counts as nothing: `layout.get` returns none for it); otherwise it throws, and
   * the state waits for a restart that loads the stored layout.
   */
  private async checkNothingUnloaded(): Promise<void> {
    const { result } = await this.core.request("layout.get", {});
    if (result.layout !== undefined) throw new Error("a stored layout was never loaded; not overwriting it");
    this.revision = result.revision;
    this.loaded = true;
  }
}
