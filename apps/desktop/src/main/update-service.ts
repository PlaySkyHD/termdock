// Auto-update of the installed app (#136) without Electron: when to look for updates, the offer to the windows,
// "Später" and the one install. The updater (electron-updater in the app, `ManualUpdater` in the screenshot run and
// the tests), the clock, the settings and the end of the core come in as functions.
import { IpcError } from "@termdock/core";
import type { BridgeEvent, UpdateChoice } from "../shared/bridge.js";
import { checksEnabled, UPDATE_CHECK_INTERVAL_MS, UPDATE_FIRST_CHECK_MS } from "../shared/update-decision.js";

/** The updater as the service needs it; `electron-updater-port.ts` adapts electron-updater to it. */
export interface UpdaterPort {
  /** Looks for an update and downloads it in the background; rejects when the check fails. */
  check(): Promise<void>;
  /** An update is downloaded and checked against its SHA-512; `version` from `latest.yml`. */
  onDownloaded(listener: (version: string) => void): void;
  /** A failed check or download, also one that `check` does not see (the download runs in the background). */
  onError(listener: (error: unknown) => void): void;
  /**
   * Starts the installer silently; it starts the app again afterwards. False when it could not start (the downloaded
   * file is gone, for example). Quitting the app is the caller's job.
   */
  install(): boolean;
}

export interface UpdateTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface UpdateServiceDeps {
  updater: UpdaterPort;
  /** The settings of the core; `undefined` when it does not answer. Read before every check. */
  readSettings(): Promise<{ checkForUpdates?: boolean | undefined } | undefined>;
  /** One event to every window. */
  broadcast(event: BridgeEvent): void;
  /**
   * Saves the layout, ends the core so its tmux sessions stay, closes the connection and then calls `install`.
   * False when the app already quits: then nothing happens.
   */
  releaseAndInstall(install: () => boolean): boolean;
  timers: UpdateTimers;
  log(text: string): void;
}

export class UpdateService {
  private timer: unknown;
  private started = false;
  private disposed = false;
  private installing = false;
  /** The downloaded update that the windows offer. */
  private ready: string | undefined;
  /** Versions the user put off with "Später" while this main process runs. */
  private readonly postponed = new Set<string>();

  constructor(private readonly deps: UpdateServiceDeps) {
    deps.updater.onDownloaded((version) => this.downloaded(version));
    deps.updater.onError((error) => deps.log(`updater: ${messageOf(error)}`));
  }

  /** Plans the first check; later checks follow each one after the interval. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.schedule(UPDATE_FIRST_CHECK_MS);
  }

  /** The update a window offers now; a window that loads later asks this once. */
  state(): { version?: string } {
    return this.ready === undefined ? {} : { version: this.ready };
  }

  /** The answer of a window: "Später" hides the offer in every window, "Jetzt neu starten" installs once. */
  answer(choice: UpdateChoice): void {
    // A second click, also in another window, while the install already runs.
    if (this.installing) return;
    const version = this.ready;
    if (version === undefined) throw new IpcError("not_found", "There is no update to answer");
    if (choice === "later") {
      this.postponed.add(version);
      this.ready = undefined;
      this.deps.broadcast({ kind: "updateChanged" });
      return;
    }
    if (!this.deps.releaseAndInstall(() => this.deps.updater.install())) {
      // A quit runs, or the core is restarting (#130): nothing is installed, and the windows that hid the dialog on
      // the click show it again.
      this.deps.log("update install: not now (the app quits or the core restarts)");
      this.deps.broadcast({ kind: "updateChanged", version });
      return;
    }
    this.installing = true;
    this.ready = undefined;
    this.stopTimer();
    this.deps.broadcast({ kind: "updateChanged" });
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
  }

  private downloaded(version: string): void {
    if (this.installing || this.ready === version || this.postponed.has(version)) return;
    this.ready = version;
    this.deps.log(`update ${version} downloaded`);
    this.deps.broadcast({ kind: "updateChanged", version });
  }

  private schedule(ms: number): void {
    this.timer = this.deps.timers.setTimeout(() => {
      this.timer = undefined;
      void this.check().finally(() => {
        if (!this.disposed && !this.installing) this.schedule(UPDATE_CHECK_INTERVAL_MS);
      });
    }, ms);
  }

  private async check(): Promise<void> {
    // Without an answer of the core the setting is unknown: the user may have turned the checks off. The next check
    // comes after the interval.
    const settings = await this.deps.readSettings().catch(() => undefined);
    if (settings === undefined) {
      this.deps.log("update check skipped: the core did not answer settings.get");
      return;
    }
    if (!checksEnabled(settings) || this.disposed || this.installing) return;
    try {
      await this.deps.updater.check();
    } catch (error) {
      this.deps.log(`update check: ${messageOf(error)}`);
    }
  }

  private stopTimer(): void {
    if (this.timer !== undefined) this.deps.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/**
 * An updater that loads the real one (`load`) at its first check, not at the start of the app: the first check comes
 * 30 s later, and the windows must not wait for electron-updater and its modules. A failed load fails that check
 * (the service logs it) and is tried again at the next one.
 */
export function lazyUpdater(load: () => Promise<UpdaterPort>): UpdaterPort {
  let loading: Promise<UpdaterPort> | undefined;
  let port: UpdaterPort | undefined;
  const downloaded: ((version: string) => void)[] = [];
  const errors: ((error: unknown) => void)[] = [];
  const get = (): Promise<UpdaterPort> =>
    (loading ??= load().then(
      (loaded) => {
        for (const listener of downloaded) loaded.onDownloaded(listener);
        for (const listener of errors) loaded.onError(listener);
        port = loaded;
        return loaded;
      },
      (error: unknown) => {
        loading = undefined;
        throw error;
      },
    ));
  return {
    check: async () => (await get()).check(),
    onDownloaded: (listener) => {
      downloaded.push(listener);
      port?.onDownloaded(listener);
    },
    onError: (listener) => {
      errors.push(listener);
      port?.onError(listener);
    },
    // Only reachable after a download, which needs a loaded updater.
    install: () => {
      if (!port) throw new Error("The updater is not loaded");
      return port.install();
    },
  };
}

/** An updater without network: `offer` reports a download, `install` only counts (screenshot run, tests). */
export class ManualUpdater implements UpdaterPort {
  installs = 0;
  private readonly downloadedListeners: ((version: string) => void)[] = [];
  private readonly errorListeners: ((error: unknown) => void)[] = [];

  async check(): Promise<void> {}

  onDownloaded(listener: (version: string) => void): void {
    this.downloadedListeners.push(listener);
  }

  onError(listener: (error: unknown) => void): void {
    this.errorListeners.push(listener);
  }

  install(): boolean {
    this.installs += 1;
    return true;
  }

  /** As if a check had found and downloaded `version`. */
  offer(version: string): void {
    for (const listener of this.downloadedListeners) listener(version);
  }

  /** As if a check or download had failed. */
  fail(error: unknown): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
