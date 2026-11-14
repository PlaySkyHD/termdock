import type { SessionInfo, SessionState } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import {
  backendText,
  coreHints,
  endedNotice,
  isAttachable,
  isRunning,
  stateText,
} from "./session-display.js";

function session(id: string, patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    name: `Session ${id}`,
    state: "Detached",
    launch: { backend: "wsl", cwd: "~" },
    size: { cols: 80, rows: 24 },
    loggingEnabled: false,
    createdAt: "2026-11-13T10:00:00Z",
    updatedAt: "2026-11-13T10:00:00Z",
    ...patch,
  };
}

describe("state helpers", () => {
  it.each<[SessionState, boolean]>([
    ["Starting", false],
    ["Running", true],
    ["Detached", false],
    ["Exited", false],
    ["Interrupted", false],
    ["Archived", false],
  ])("%s counts as running: %s", (state, running) => {
    expect(isRunning(state)).toBe(running);
  });

  it.each<[SessionState, boolean]>([
    ["Starting", false],
    ["Running", true],
    ["Detached", true],
    ["Exited", false],
    ["Interrupted", false],
    ["Archived", false],
  ])("a tab of a %s session attaches: %s", (state, attachable) => {
    expect(isAttachable(state)).toBe(attachable);
  });
});

describe("endedNotice", () => {
  it("says an exited session ended and names the exit code", () => {
    expect(endedNotice(session("a", { state: "Exited", lastExitCode: 2 }))).toEqual({
      title: "Beendet",
      detail: "Der Prozess ist mit Exit-Code 2 beendet.",
    });
  });

  it("does not invent an exit code", () => {
    expect(endedNotice(session("a", { state: "Exited" }))?.detail).toBe("Der Prozess ist beendet.");
  });

  it("calls an interrupted session interrupted, never running", () => {
    const notice = endedNotice(session("a", { state: "Interrupted" }));

    expect(notice?.title).toBe("Unterbrochen");
    expect(notice?.detail).not.toMatch(/läuft/i);
  });

  it("says a starting session is starting", () => {
    expect(endedNotice(session("a", { state: "Starting" }))?.title).toBe("Startet");
  });

  it("has nothing to say for a session that can be attached", () => {
    expect(endedNotice(session("a", { state: "Running" }))).toBeUndefined();
    expect(endedNotice(session("a", { state: "Detached" }))).toBeUndefined();
  });
});

describe("backendText", () => {
  it("names backend and distro", () => {
    expect(backendText({ backend: "wsl", distro: "Ubuntu", cwd: "~" })).toBe("WSL · Ubuntu");
  });

  it("says default distro when none is set", () => {
    expect(backendText({ backend: "wsl", cwd: "~" })).toBe("WSL · Standard-Distro");
  });

  it("names the shell of the windows backend", () => {
    expect(backendText({ backend: "windows", shell: "pwsh", cwd: "C:\\" })).toBe("Windows · pwsh");
  });
});

describe("coreHints", () => {
  it("is empty while everything is reachable", () => {
    expect(coreHints({ backendUnavailable: [] }, false)).toEqual([]);
    expect(coreHints(undefined, false)).toEqual([]);
  });

  it("warns about each backend the core could not reach", () => {
    expect(coreHints({ backendUnavailable: ["wsl", "windows"] }, false)).toEqual([
      "WSL nicht erreichbar",
      "Windows nicht erreichbar",
    ]);
  });

  it("reports the lost connection first", () => {
    expect(coreHints({ backendUnavailable: ["wsl"] }, true)).toEqual([
      "Verbindung zum Core getrennt",
      "WSL nicht erreichbar",
    ]);
  });
});

describe("stateText", () => {
  it("names the state and adds the exit code of an exited session", () => {
    expect(stateText(session("a", { state: "Exited", lastExitCode: 0 }))).toBe("Exited (Code 0)");
    expect(stateText(session("a", { state: "Exited" }))).toBe("Exited");
  });

  it("names every other state as it is", () => {
    expect(stateText(session("a", { state: "Interrupted", lastExitCode: 1 }))).toBe("Interrupted");
    expect(stateText(session("a", { state: "Running" }))).toBe("Running");
    expect(stateText(session("a", { state: "Detached" }))).toBe("Detached");
  });
});
