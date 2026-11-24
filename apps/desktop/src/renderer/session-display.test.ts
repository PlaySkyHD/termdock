import type { SessionInfo, SessionState } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import {
  backendText,
  canRestart,
  coreHints,
  endedNotice,
  isAttachable,
  isRunning,
  persistenceLimit,
  rawSnapshot,
  stateText,
  warningTexts,
  WINDOWS_PERSISTENCE_TEXT,
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

  it.each<[SessionState, boolean]>([
    ["Starting", false],
    ["Running", false],
    ["Detached", false],
    ["Exited", true],
    ["Interrupted", true],
    ["Archived", false],
  ])("a %s session can be restarted: %s (#156)", (state, restartable) => {
    expect(canRestart(state)).toBe(restartable);
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

  it("[V1-15] says an interrupted Windows session ended with the core, which it only runs alongside", () => {
    const notice = endedNotice(
      session("w", { state: "Interrupted", launch: { backend: "windows", shell: "pwsh", cwd: "~" } }),
    );
    expect(notice?.title).toBe("Unterbrochen");
    expect(notice?.detail).toContain("mit dem Core beendet");
    expect(notice?.detail).toContain("nur, solange der TermDock-Core läuft");
    expect(notice?.detail).not.toContain("tmux");
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

describe("persistenceLimit (#65)", () => {
  it("[V1-15] marks Windows shells with a badge, a tooltip and the note of the status bar", () => {
    expect(persistenceLimit({ backend: "windows", shell: "cmd" })).toEqual({
      label: "Win",
      title:
        "Windows-Shell (cmd) · Läuft nur, solange der TermDock-Core läuft; ein Neustart des Core oder von Windows unterbricht sie.",
      note: WINDOWS_PERSISTENCE_TEXT,
    });
    expect(persistenceLimit({ backend: "windows" })?.title).toMatch(/^Windows-Shell · Läuft nur/);
    expect(WINDOWS_PERSISTENCE_TEXT).toBe("Läuft nur, solange der TermDock-Core läuft");
  });

  it("[V1-15] says nothing for WSL sessions, which live on in tmux", () => {
    expect(persistenceLimit({ backend: "wsl" })).toBeUndefined();
  });

  it("takes the snapshot of a Windows session as raw output, that of a WSL session as tmux screen", () => {
    expect(rawSnapshot({ backend: "windows" })).toBe(true);
    expect(rawSnapshot({ backend: "wsl" })).toBe(false);
  });
});

describe("coreHints", () => {
  it("is empty while everything is reachable", () => {
    expect(coreHints({ backendUnavailable: [] }, false)).toEqual([]);
    expect(coreHints(undefined, false)).toEqual([]);
  });

  it("[V1-09] warns about each backend the core could not reach", () => {
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

  it("names a restart of the core instead of the lost connection (#130)", () => {
    expect(coreHints(undefined, true, true)).toEqual(["Core startet neu …"]);
    expect(coreHints(undefined, false, true)).toEqual([]);
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

// Issue #113 (openspec change missing-cwd-warning).
describe("warningTexts", () => {
  const missing = { code: "cwd_missing", path: "/srv/api", distro: "Ubuntu" };

  it("names the missing directory, the distro and where the shell runs", () => {
    expect(warningTexts(session("a", { state: "Running", warnings: [missing] }), [])).toEqual([
      {
        text: "Verzeichnis /srv/api fehlt in Ubuntu – die Session läuft im Wurzelverzeichnis /.",
        before: "Verzeichnis ",
        path: "/srv/api",
        after: " fehlt in Ubuntu – die Session läuft im Wurzelverzeichnis /.",
      },
    ]);
    const withoutDistro = session("a", {
      launch: { backend: "wsl", distro: "Debian", cwd: "/srv/api" },
      warnings: [{ code: "cwd_missing", path: "/srv/api" }],
    });
    expect(warningTexts(withoutDistro, []).map((each) => each.text)).toEqual([
      "Verzeichnis /srv/api fehlt in Debian – die Session läuft im Wurzelverzeichnis /.",
    ]);
  });

  it("says a Windows shell runs in the user folder instead (#65)", () => {
    const windows = session("w", {
      state: "Running",
      launch: { backend: "windows", shell: "cmd", cwd: "D:\\gone" },
      warnings: [{ code: "cwd_missing", path: "D:\\gone" }],
    });
    expect(warningTexts(windows, []).map((each) => each.text)).toEqual([
      "Verzeichnis D:\\gone fehlt – die Session läuft im Benutzerordner.",
    ]);
  });

  it("shows nothing once dismissed, without warnings, for unknown codes or a session that does not live", () => {
    expect(warningTexts(session("a", { warnings: [missing] }), ["a"])).toEqual([]);
    expect(warningTexts(session("a"), [])).toEqual([]);
    expect(warningTexts(undefined, [])).toEqual([]);
    expect(warningTexts(session("a", { warnings: [{ code: "later_code", path: "/x" }] }), [])).toEqual([]);
    expect(warningTexts(session("a", { state: "Exited", warnings: [missing] }), [])).toEqual([]);
  });
});
