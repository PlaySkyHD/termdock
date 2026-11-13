import { describe, expect, it } from "vitest";
import type { SessionState } from "@termdock/protocol";
import { CoreError } from "./errors.js";
import { canTransition, transition } from "./lifecycle.js";

// Source of truth: ADR 0005, "Zustandsautomat".
const allowed: ReadonlyArray<readonly [SessionState, SessionState]> = [
  ["Starting", "Running"],
  ["Starting", "Interrupted"],
  ["Starting", "Exited"],
  ["Running", "Detached"],
  ["Detached", "Running"],
  ["Running", "Exited"],
  ["Detached", "Exited"],
  ["Running", "Interrupted"],
  ["Detached", "Interrupted"],
  ["Exited", "Starting"],
  ["Interrupted", "Starting"],
  ["Exited", "Archived"],
  ["Interrupted", "Archived"],
  ["Detached", "Archived"],
  ["Running", "Archived"],
];

const forbidden: ReadonlyArray<readonly [SessionState, SessionState]> = [
  ["Starting", "Detached"],
  ["Starting", "Archived"],
  ["Exited", "Running"],
  ["Interrupted", "Detached"],
  ["Exited", "Interrupted"],
  ["Archived", "Starting"],
  ["Archived", "Running"],
  ["Running", "Starting"],
  ["Running", "Running"],
];

describe("session lifecycle", () => {
  it.each(allowed)("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(transition(from, to)).toBe(to);
  });

  it.each(forbidden)("rejects %s -> %s with invalid_state", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    let error: unknown;
    try {
      transition(from, to);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe("invalid_state");
  });

  it("allows exactly the transitions from ADR 0005", () => {
    const states: SessionState[] = ["Starting", "Running", "Detached", "Exited", "Interrupted", "Archived"];
    const actual = states.flatMap((from) =>
      states.filter((to) => canTransition(from, to)).map((to) => `${from}->${to}`),
    );
    expect(actual.sort()).toEqual(allowed.map(([from, to]) => `${from}->${to}`).sort());
  });
});
