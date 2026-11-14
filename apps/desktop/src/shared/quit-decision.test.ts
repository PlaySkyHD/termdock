import { describe, expect, it } from "vitest";
import { countActive, outcomeOfAnswer, planQuit, quitMessage } from "./quit-decision.js";

const asking = { confirmQuitWhileRunning: true };

describe("countActive", () => {
  it("counts Running and Detached only", () => {
    const states = ["Running", "Detached", "Starting", "Exited", "Interrupted", "Running"] as const;
    expect(countActive(states.map((state) => ({ state })))).toBe(3);
  });
});

describe("planQuit", () => {
  it("does not ask without a running session", () => {
    expect(planQuit({ reason: "user", activeSessions: 0, settings: asking })).toEqual({
      kind: "quit",
      stopSessions: false,
    });
  });

  it("does not ask without a running session even when the stored action stops sessions", () => {
    const settings = { confirmQuitWhileRunning: false, quitAction: "stopSessions" as const };
    expect(planQuit({ reason: "user", activeSessions: 0, settings })).toEqual({
      kind: "quit",
      stopSessions: false,
    });
  });

  it("asks while sessions run and the question is on", () => {
    expect(planQuit({ reason: "user", activeSessions: 2, settings: asking })).toEqual({ kind: "ask" });
  });

  it("applies the stored choice without asking", () => {
    expect(
      planQuit({
        reason: "user",
        activeSessions: 2,
        settings: { confirmQuitWhileRunning: false, quitAction: "stopSessions" },
      }),
    ).toEqual({ kind: "quit", stopSessions: true });
    expect(
      planQuit({
        reason: "user",
        activeSessions: 2,
        settings: { confirmQuitWhileRunning: false, quitAction: "keepSessions" },
      }),
    ).toEqual({ kind: "quit", stopSessions: false });
  });

  it("keeps the sessions when the question is off and no action is stored", () => {
    expect(
      planQuit({ reason: "user", activeSessions: 1, settings: { confirmQuitWhileRunning: false } }),
    ).toEqual({ kind: "quit", stopSessions: false });
  });

  it("never asks and never stops at the end of the Windows session", () => {
    for (const settings of [
      asking,
      { confirmQuitWhileRunning: false, quitAction: "stopSessions" as const },
    ]) {
      expect(planQuit({ reason: "session-end", activeSessions: 3, settings })).toEqual({
        kind: "quit",
        stopSessions: false,
      });
    }
  });
});

describe("outcomeOfAnswer", () => {
  it("cancel quits nothing and stores nothing, also with the checkbox", () => {
    expect(outcomeOfAnswer({ choice: "cancel", remember: false })).toEqual({ kind: "cancel" });
    expect(outcomeOfAnswer({ choice: "cancel", remember: true })).toEqual({ kind: "cancel" });
  });

  it("keeps or stops the sessions without storing when the checkbox is off", () => {
    expect(outcomeOfAnswer({ choice: "keepSessions", remember: false })).toEqual({
      kind: "quit",
      stopSessions: false,
    });
    expect(outcomeOfAnswer({ choice: "stopSessions", remember: false })).toEqual({
      kind: "quit",
      stopSessions: true,
    });
  });

  it("stores the question and the action when the checkbox is on", () => {
    expect(outcomeOfAnswer({ choice: "stopSessions", remember: true })).toEqual({
      kind: "quit",
      stopSessions: true,
      remember: { confirmQuitWhileRunning: false, quitAction: "stopSessions" },
    });
    expect(outcomeOfAnswer({ choice: "keepSessions", remember: true })).toEqual({
      kind: "quit",
      stopSessions: false,
      remember: { confirmQuitWhileRunning: false, quitAction: "keepSessions" },
    });
  });
});

describe("quitMessage", () => {
  it("names the number of sessions", () => {
    expect(quitMessage(1)).toBe("1 Session läuft noch.");
    expect(quitMessage(4)).toBe("4 Sessions laufen noch.");
  });
});
