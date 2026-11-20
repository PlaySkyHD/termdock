import type { SessionInfo, SessionState } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import {
  clearsRestartError,
  RESTART_IDLE,
  restartBar,
  restartFromMenu,
  restartFromPlaceholder,
  withoutStaleRefusal,
} from "./restart-session.js";
import type { RestartStatus } from "./restart-session.js";
import type { ViewRole } from "./terminal-controller.js";

function session(state: SessionState, lastExitCode?: number): SessionInfo {
  return {
    id: "s1",
    name: "Build",
    state,
    launch: { backend: "wsl", cwd: "/" },
    size: { cols: 80, rows: 24 },
    loggingEnabled: false,
    createdAt: "2026-11-20T10:00:00Z",
    updatedAt: "2026-11-20T10:00:00Z",
    ...(lastExitCode === undefined ? {} : { lastExitCode }),
  };
}

/** The bridge rejects with the core's code in front of its message. */
const refused = () => Promise.reject(new Error("[backend_unavailable] Session s1 could not be started"));

describe("restartFromPlaceholder (#156)", () => {
  it("disables the button while the restart runs and frees it when the core has answered", async () => {
    const seen: RestartStatus[] = [];
    let calls = 0;

    await restartFromPlaceholder(
      RESTART_IDLE,
      async () => void calls++,
      (status) => seen.push(status),
    );

    expect(calls).toBe(1);
    expect(seen).toEqual([{ running: true, error: undefined }, RESTART_IDLE]);
  });

  it("shows the core's refusal and makes the button usable again", async () => {
    const seen: RestartStatus[] = [];

    await restartFromPlaceholder(RESTART_IDLE, refused, (status) => seen.push(status));

    expect(seen.at(-1)).toEqual({ running: false, error: "Session s1 could not be started" });
  });

  it("clears the last refusal when the user tries again", async () => {
    const seen: RestartStatus[] = [];

    await restartFromPlaceholder(
      { running: false, error: "Session s1 could not be started" },
      async () => {},
      (status) => seen.push(status),
    );

    expect(seen).toEqual([{ running: true, error: undefined }, RESTART_IDLE]);
  });

  it("sends nothing while a restart runs", () => {
    let calls = 0;
    const seen: RestartStatus[] = [];

    const result = restartFromPlaceholder(
      { running: true, error: undefined },
      async () => void calls++,
      (status) => seen.push(status),
    );

    expect(result).toBeUndefined();
    expect(calls).toBe(0);
    expect(seen).toEqual([]);
  });
});

describe("restartFromMenu (#156)", () => {
  it("puts the core's refusal into the status bar", async () => {
    const notices: string[] = [];

    await restartFromMenu(refused, (message) => notices.push(message));

    expect(notices).toEqual(["Session s1 could not be started"]);
  });

  it("says nothing when the restart works", async () => {
    const notices: string[] = [];

    await restartFromMenu(
      async () => {},
      (message) => notices.push(message),
    );

    expect(notices).toEqual([]);
  });
});

describe("restartBar of an attached view (#164)", () => {
  it.each<SessionState>(["Running", "Detached", "Starting", "Archived"])(
    "shows no bar while the session is %s",
    (state) => {
      expect(restartBar(session(state), "writer", RESTART_IDLE)).toBeUndefined();
      expect(restartBar(session(state), "reader", RESTART_IDLE)).toBeUndefined();
    },
  );

  it("shows no bar before the session list knows the session", () => {
    expect(restartBar(undefined, "writer", RESTART_IDLE)).toBeUndefined();
  });

  it("gives the writer of an Exited session the button with state and exit code", () => {
    expect(restartBar(session("Exited", 0), "writer", RESTART_IDLE)).toEqual({
      kind: "button",
      title: "Beendet",
      detail: "Der Prozess ist mit Exit-Code 0 beendet.",
      running: false,
      error: undefined,
    });
  });

  it("gives the writer of an Interrupted session the button", () => {
    expect(restartBar(session("Interrupted"), "writer", RESTART_IDLE)).toMatchObject({
      kind: "button",
      title: "Unterbrochen",
    });
  });

  it.each<SessionState>(["Exited", "Interrupted"])("gives a reader of a %s session only a hint", (state) => {
    const bar = restartBar(session(state), "reader", RESTART_IDLE);

    expect(bar).toMatchObject({ kind: "hint" });
    expect(bar).not.toHaveProperty("running");
    // A reader may be the only view left (its writer's pane closed): it says how to get the button.
    expect(bar?.detail).toMatch(/Eingabe übernehmen/);
  });

  it.each<ViewRole | undefined>([undefined, "connecting", "error", "restarting", "closed"])(
    "shows nothing in a view that is %s",
    (role) => {
      expect(restartBar(session("Interrupted"), role, RESTART_IDLE)).toBeUndefined();
    },
  );

  it("disables the button while the restart runs", () => {
    expect(restartBar(session("Exited", 1), "writer", { running: true, error: undefined })).toMatchObject({
      kind: "button",
      running: true,
    });
  });

  it("shows a refusal of the core in the bar and frees the button again", async () => {
    let status: RestartStatus = RESTART_IDLE;
    await restartFromPlaceholder(
      status,
      () => Promise.reject(new Error("[backend_unavailable] Session s1 could not be started")),
      (next) => (status = next),
    );

    expect(restartBar(session("Interrupted"), "writer", status)).toMatchObject({
      kind: "button",
      running: false,
      error: "Session s1 could not be started",
    });
  });
});

describe("withoutStaleRefusal (#164, review)", () => {
  const refusedStatus: RestartStatus = { running: false, error: "[timeout] session.restart" };

  it("drops a refusal that arrives after the session lives again", () => {
    expect(withoutStaleRefusal(refusedStatus, "Running")).toEqual(RESTART_IDLE);
  });

  it("keeps the refusal of a restart that left the session Interrupted", () => {
    expect(withoutStaleRefusal(refusedStatus, "Interrupted")).toBe(refusedStatus);
  });

  it("keeps the refusal while the session list does not know the session", () => {
    expect(withoutStaleRefusal(refusedStatus, undefined)).toBe(refusedStatus);
  });

  it("leaves a running restart alone", () => {
    const running = { running: true, error: undefined };

    expect(withoutStaleRefusal(running, "Running")).toBe(running);
  });
});

describe("clearsRestartError (#164)", () => {
  it.each<[SessionState, boolean]>([
    ["Running", true],
    ["Detached", true],
    ["Archived", true],
    // A failed restart passes Starting and ends Interrupted; its refusal may arrive in the same render.
    ["Starting", false],
    ["Exited", false],
    ["Interrupted", false],
  ])("a session that is %s clears the refusal: %s", (state, clears) => {
    expect(clearsRestartError(state)).toBe(clears);
  });
});
