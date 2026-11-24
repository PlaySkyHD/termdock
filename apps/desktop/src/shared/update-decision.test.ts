import { describe, expect, it } from "vitest";
import {
  checksEnabled,
  NO_UPDATE_OFFER,
  nextUpdateOffer,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_FIRST_CHECK_MS,
  updateChecksAllowed,
  updateMessage,
  updateSessionsNote,
} from "./update-decision.js";

describe("updateChecksAllowed (#136)", () => {
  it("allows checks only in the packaged app in its normal start", () => {
    expect(updateChecksAllowed({ packaged: true, mode: "app" })).toBe(true);
    expect(updateChecksAllowed({ packaged: false, mode: "app" })).toBe(false);
    for (const mode of ["screenshot", "smoke-test"] as const) {
      expect(updateChecksAllowed({ packaged: true, mode }), mode).toBe(false);
      expect(updateChecksAllowed({ packaged: false, mode }), mode).toBe(false);
    }
  });
});

describe("checksEnabled", () => {
  it("is on without a key, off only for false", () => {
    expect(checksEnabled({})).toBe(true);
    expect(checksEnabled({ checkForUpdates: true })).toBe(true);
    expect(checksEnabled({ checkForUpdates: false })).toBe(false);
  });
});

describe("the schedule", () => {
  it("checks 30 s after the start and then every 4 hours", () => {
    expect(UPDATE_FIRST_CHECK_MS).toBe(30_000);
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(4 * 60 * 60 * 1000);
  });
});

describe("nextUpdateOffer", () => {
  it("shows the version of the answer or the event and hides it on an event without one", () => {
    const asked = nextUpdateOffer(NO_UPDATE_OFFER, { kind: "state", version: "0.2.0" });
    expect(asked).toEqual({ version: "0.2.0", fromEvent: false });
    const hidden = nextUpdateOffer(asked, { kind: "event" });
    expect(hidden).toEqual({ fromEvent: true });
    expect(nextUpdateOffer(hidden, { kind: "event", version: "0.3.0" })).toEqual({
      version: "0.3.0",
      fromEvent: true,
    });
  });

  it("keeps an event against a later answer of updateState", () => {
    // "Später" in another window came before the answer to the question of this page.
    const hidden = nextUpdateOffer(NO_UPDATE_OFFER, { kind: "event" });
    expect(nextUpdateOffer(hidden, { kind: "state", version: "0.2.0" })).toBe(hidden);
  });
});

describe("texts of the update dialog", () => {
  it("names the version", () => {
    expect(updateMessage("0.2.0")).toBe("Update auf Version 0.2.0 ist bereit.");
  });

  it("says that WSL sessions keep running and Windows shells end", () => {
    expect(updateSessionsNote(0)).toBe(
      "Der Neustart installiert das Update. WSL-Sessions laufen weiter, TermDock bindet sie danach wieder an.",
    );
    expect(updateSessionsNote(1)).toBe(
      "Der Neustart installiert das Update. WSL-Sessions laufen weiter, die laufende Windows-Shell endet dabei.",
    );
    expect(updateSessionsNote(3)).toBe(
      "Der Neustart installiert das Update. WSL-Sessions laufen weiter, die 3 laufenden Windows-Shells enden dabei.",
    );
  });
});
