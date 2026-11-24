import { IpcError } from "@termdock/core";
import { describe, expect, it } from "vitest";
import type { BridgeEvent } from "../shared/bridge.js";
import { UPDATE_CHECK_INTERVAL_MS, UPDATE_FIRST_CHECK_MS } from "../shared/update-decision.js";
import { lazyUpdater, ManualUpdater, UpdateService } from "./update-service.js";
import type { UpdateServiceDeps } from "./update-service.js";

/** A clock whose timers run only when the test says so. */
class FakeTimers {
  private next = 1;
  readonly pending = new Map<number, { at: number; fn: () => void }>();
  now = 0;

  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.next++;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  };

  clearTimeout = (id: unknown): void => void this.pending.delete(id as number);

  /** Runs every timer due within `ms`, in order, and lets their promises settle. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.pending].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
      await settle();
    }
    this.now = end;
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** The updater of the tests: counts checks, can fail, and reports downloads on demand. */
class FakeUpdater extends ManualUpdater {
  checks = 0;
  failWith: Error | undefined;

  override async check(): Promise<void> {
    this.checks += 1;
    if (this.failWith) throw this.failWith;
  }
}

function setup(overrides: Partial<UpdateServiceDeps> = {}) {
  const timers = new FakeTimers();
  const updater = new FakeUpdater();
  const events: BridgeEvent[] = [];
  const logs: string[] = [];
  const settings: { value: { checkForUpdates?: boolean } | undefined } = { value: {} };
  const releases: (() => void)[] = [];
  let releaseAnswer = true;
  const deps: UpdateServiceDeps = {
    updater,
    readSettings: async () => settings.value,
    broadcast: (event) => events.push(event),
    releaseAndInstall: (install) => {
      releases.push(install);
      return releaseAnswer;
    },
    timers,
    log: (text) => logs.push(text),
    ...overrides,
  };
  const service = new UpdateService(deps);
  return {
    timers,
    updater,
    events,
    logs,
    settings,
    releases,
    service,
    refuseRelease: () => (releaseAnswer = false),
  };
}

describe("UpdateService schedule (#136)", () => {
  it("checks 30 s after the start and then every 4 hours", async () => {
    const { timers, updater, service } = setup();
    service.start();
    await timers.advance(UPDATE_FIRST_CHECK_MS - 1);
    expect(updater.checks).toBe(0);
    await timers.advance(1);
    expect(updater.checks).toBe(1);
    await timers.advance(UPDATE_CHECK_INTERVAL_MS);
    expect(updater.checks).toBe(2);
    await timers.advance(UPDATE_CHECK_INTERVAL_MS);
    expect(updater.checks).toBe(3);
  });

  it("does not check while the setting is off, and checks again once it is on", async () => {
    const { timers, updater, settings, service } = setup();
    settings.value = { checkForUpdates: false };
    service.start();
    await timers.advance(UPDATE_FIRST_CHECK_MS + UPDATE_CHECK_INTERVAL_MS);
    expect(updater.checks).toBe(0);
    settings.value = { checkForUpdates: true };
    await timers.advance(UPDATE_CHECK_INTERVAL_MS);
    expect(updater.checks).toBe(1);
  });

  it("skips a check when the core does not answer the settings: the user may have turned it off (review)", async () => {
    const answers: ({ checkForUpdates?: boolean } | undefined)[] = [undefined, {}];
    const { timers, updater, logs, service } = setup({ readSettings: async () => answers.shift() });
    service.start();
    await timers.advance(UPDATE_FIRST_CHECK_MS);
    expect(updater.checks).toBe(0);
    expect(logs).toEqual(["update check skipped: the core did not answer settings.get"]);
    await timers.advance(UPDATE_CHECK_INTERVAL_MS);
    expect(updater.checks).toBe(1);
  });

  it("only logs failed checks and updater errors, and checks again later", async () => {
    const { timers, updater, events, logs, service } = setup();
    updater.failWith = new Error("net::ERR_INTERNET_DISCONNECTED");
    service.start();
    await timers.advance(UPDATE_FIRST_CHECK_MS);
    updater.fail(new Error("sha512 checksum mismatch"));
    expect(logs).toEqual([
      "update check: net::ERR_INTERNET_DISCONNECTED",
      "updater: sha512 checksum mismatch",
    ]);
    expect(events).toEqual([]);
    updater.failWith = undefined;
    await timers.advance(UPDATE_CHECK_INTERVAL_MS);
    expect(updater.checks).toBe(2);
  });

  it("survives settings that throw and plans the next check", async () => {
    const { timers, updater, logs, service } = setup({
      readSettings: () => Promise.reject(new Error("closed")),
    });
    service.start();
    await timers.advance(UPDATE_FIRST_CHECK_MS);
    expect(updater.checks).toBe(0);
    expect(logs).toEqual(["update check skipped: the core did not answer settings.get"]);
    expect(timers.pending.size).toBe(1);
  });

  it("stops checking after dispose", async () => {
    const { timers, updater, service } = setup();
    service.start();
    service.dispose();
    await timers.advance(UPDATE_FIRST_CHECK_MS + UPDATE_CHECK_INTERVAL_MS);
    expect(updater.checks).toBe(0);
    expect(timers.pending.size).toBe(0);
  });
});

describe("lazyUpdater (review: no import on the start path)", () => {
  it("loads the updater at the first check, passes the listeners on and retries a failed load", async () => {
    const real = new FakeUpdater();
    let loads = 0;
    let fail = true;
    const updater = lazyUpdater(async () => {
      loads += 1;
      if (fail) throw new Error("cannot load electron-updater");
      return real;
    });
    const versions: string[] = [];
    updater.onDownloaded((version) => versions.push(version));
    expect(loads).toBe(0);
    expect(() => updater.install()).toThrow(/not loaded/);
    await expect(updater.check()).rejects.toThrow("cannot load electron-updater");
    fail = false;
    await updater.check();
    await updater.check();
    expect(loads).toBe(2);
    expect(real.checks).toBe(2);
    real.offer("0.2.0");
    expect(versions).toEqual(["0.2.0"]);
    updater.install();
    expect(real.installs).toBe(1);
  });
});

describe("UpdateService offer and answers", () => {
  it("offers a downloaded update to every window once, also to a window that asks later", () => {
    const { updater, events, service } = setup();
    expect(service.state()).toEqual({});
    updater.offer("0.2.0");
    updater.offer("0.2.0"); // a later check finds the same download in the cache
    expect(events).toEqual([{ kind: "updateChanged", version: "0.2.0" }]);
    expect(service.state()).toEqual({ version: "0.2.0" });
  });

  it("hides the dialog everywhere on Später and does not offer that version again", () => {
    const { updater, events, service } = setup();
    updater.offer("0.2.0");
    service.answer("later");
    expect(events.at(-1)).toEqual({ kind: "updateChanged" });
    expect(service.state()).toEqual({});
    updater.offer("0.2.0");
    expect(events).toHaveLength(2);
    // A newer version is a new question.
    updater.offer("0.3.0");
    expect(events.at(-1)).toEqual({ kind: "updateChanged", version: "0.3.0" });
  });

  it("answers not_found without an offered update", () => {
    const { service } = setup();
    expect(() => service.answer("install")).toThrow(IpcError);
    expect(() => service.answer("later")).toThrow(/no update/i);
  });

  it("installs once: release the core, then the installer, and no more checks", async () => {
    const { timers, updater, events, releases, service } = setup();
    service.start();
    updater.offer("0.2.0");
    service.answer("install");
    service.answer("install");
    expect(releases).toHaveLength(1);
    expect(updater.installs).toBe(0); // the release runs first; it calls the installer at its end
    releases[0]?.();
    expect(updater.installs).toBe(1);
    expect(events.at(-1)).toEqual({ kind: "updateChanged" });
    await timers.advance(UPDATE_FIRST_CHECK_MS + UPDATE_CHECK_INTERVAL_MS);
    expect(updater.checks).toBe(0);
  });

  it("keeps the offer and shows it again when the release is refused (quit or core restart)", () => {
    const { updater, events, releases, logs, service, refuseRelease } = setup();
    refuseRelease();
    updater.offer("0.2.0");
    service.answer("install");
    expect(releases).toHaveLength(1);
    expect(updater.installs).toBe(0);
    expect(logs).toEqual([
      "update 0.2.0 downloaded",
      "update install: not now (the app quits or the core restarts)",
    ]);
    expect(service.state()).toEqual({ version: "0.2.0" });
    expect(events.at(-1)).toEqual({ kind: "updateChanged", version: "0.2.0" });
  });
});
