import { describe, expect, it } from "vitest";
import { RESTART_IDLE, restartFromMenu, restartFromPlaceholder } from "./restart-session.js";
import type { RestartStatus } from "./restart-session.js";

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
