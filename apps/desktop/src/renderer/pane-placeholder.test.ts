import type { SessionInfo, SessionState } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import { paneContent } from "./pane-placeholder.js";

function session(state: SessionState, lastExitCode?: number): SessionInfo {
  return {
    id: "s1",
    name: "Build",
    state,
    launch: { backend: "wsl", cwd: "/" },
    size: { cols: 80, rows: 24 },
    loggingEnabled: false,
    createdAt: "2026-11-14T10:00:00Z",
    updatedAt: "2026-11-14T10:00:00Z",
    ...(lastExitCode === undefined ? {} : { lastExitCode }),
  };
}

describe("paneContent", () => {
  it.each<SessionState>(["Running", "Detached"])("attaches a view to a %s session", (state) => {
    expect(paneContent(session(state), true)).toEqual({ kind: "terminal" });
  });

  it("names state and exit code of an Exited session", () => {
    expect(paneContent(session("Exited", 130), true)).toEqual({
      kind: "placeholder",
      title: "Beendet",
      detail: "Der Prozess ist mit Exit-Code 130 beendet.",
      state: "Exited",
      exitCode: "130",
    });
  });

  it("says the exit code is unknown when the core has none", () => {
    expect(paneContent(session("Exited"), true)).toMatchObject({ state: "Exited", exitCode: "unbekannt" });
  });

  it("shows an Interrupted session as a placeholder, never as running", () => {
    const content = paneContent(session("Interrupted"), true);
    expect(content).toMatchObject({ kind: "placeholder", title: "Unterbrochen", state: "Interrupted" });
    expect(JSON.stringify(content)).not.toContain("Running");
  });

  it.each<SessionState>(["Starting", "Archived"])("shows a %s session as a placeholder", (state) => {
    expect(paneContent(session(state), true)).toMatchObject({ kind: "placeholder", state });
  });

  it("calls a session the core does not know missing, once the list has arrived", () => {
    expect(paneContent(undefined, true)).toEqual({
      kind: "placeholder",
      title: "Session nicht gefunden",
      detail: "Der Core kennt diese Session nicht (mehr).",
      state: "Fehlt",
      exitCode: "unbekannt",
    });
  });

  it("waits for the list before it calls a session missing", () => {
    expect(paneContent(undefined, false)).toEqual({ kind: "loading" });
  });

  it("does not wait for a session it already knows", () => {
    expect(paneContent(session("Interrupted"), false)).toMatchObject({ kind: "placeholder" });
  });
});
