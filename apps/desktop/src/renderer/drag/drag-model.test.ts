import { describe, expect, it } from "vitest";
import { DRAG_THRESHOLD_PX, dropHighlight, IDLE, isDragGesture, step } from "./drag-model.js";
import type { DragEnvironment, DragEvent, DragPayload, DragState } from "./drag-model.js";

const payload: DragPayload = { kind: "session", id: "s1", label: "Build" };

/** Targets a, b, c exist; the payload may go to a and b, not to c. */
const env: DragEnvironment = {
  targets: () => ["a", "b", "c"],
  accepts: (_payload, id) => id !== "c",
};

/** Runs the events in order; returns the final state and every effect. */
function run(events: DragEvent[], start: DragState = IDLE) {
  let state = start;
  const effects: unknown[] = [];
  for (const event of events) {
    const result = step(state, event, env);
    state = result.state;
    if (result.effect) effects.push(result.effect);
  }
  return { state, effects };
}

const press: DragEvent = { type: "press", payload, x: 10, y: 10 };
const far = (over?: string): DragEvent => ({ type: "move", x: 10 + DRAG_THRESHOLD_PX, y: 10, over });

describe("drag model", () => {
  it("stays a press below the threshold, so a click is a click", () => {
    const { state } = run([press, { type: "move", x: 13, y: 12, over: "a" }]);
    expect(state).toMatchObject({ phase: "pressed" });
  });

  it("starts dragging at the threshold and marks every target that accepts the payload", () => {
    const { state } = run([press, far("c")]);

    expect(state).toEqual({ phase: "dragging", payload, x: 15, y: 10, valid: ["a", "b"], over: undefined });
  });

  it("names the valid target under the pointer and clears it when the pointer leaves", () => {
    const over = run([press, far(), { type: "move", x: 30, y: 10, over: "b" }]).state;
    expect(over).toMatchObject({ phase: "dragging", over: "b", valid: ["a", "b"] });

    const left = run([{ type: "move", x: 40, y: 10, over: undefined }], over).state;
    expect(left).toMatchObject({ phase: "dragging", over: undefined });
  });

  it("does not make an invalid target the one under the pointer", () => {
    const { state } = run([press, far(), { type: "move", x: 30, y: 10, over: "c" }]);
    expect(state).toMatchObject({ phase: "dragging", over: undefined });
  });

  it("drops on a valid target at the release", () => {
    const { state, effects } = run([press, far(), { type: "release", x: 30, y: 10, over: "b" }]);

    expect(state).toEqual(IDLE);
    expect(effects).toEqual([{ kind: "drop", payload, targetId: "b" }]);
  });

  it.each([
    ["over an invalid target", "c"],
    ["over no target", undefined],
  ])("cancels when released %s", (_name, over) => {
    const { state, effects } = run([press, far("a"), { type: "release", x: 30, y: 10, over }]);

    expect(state).toEqual(IDLE);
    expect(effects).toEqual([{ kind: "cancel" }]);
  });

  it("judges the target again at the release, not by the last move", () => {
    const env2: DragEnvironment = { targets: () => ["a"], accepts: (_p, id) => id === "a" };
    const dragged = step(step(IDLE, press, env2).state, far("a"), env2).state;
    const stale: DragEnvironment = { targets: () => [], accepts: () => false };

    expect(step(dragged, { type: "release", x: 20, y: 10, over: "a" }, stale)).toEqual({
      state: IDLE,
      effect: { kind: "cancel" },
    });
  });

  it("aborts on Esc without highlight, and the later release does nothing", () => {
    const aborted = run([press, far("a"), { type: "escape" }]);
    expect(aborted.state).toEqual({ phase: "aborted" });
    expect(aborted.effects).toEqual([{ kind: "cancel" }]);
    expect(dropHighlight(aborted.state, "a")).toBe("none");

    const released = run(
      [
        { type: "move", x: 50, y: 50, over: "a" },
        { type: "release", x: 50, y: 50, over: "a" },
      ],
      aborted.state,
    );
    expect(released.state).toEqual(IDLE);
    expect(released.effects).toEqual([]);
  });

  it("drops a press on Esc without an effect", () => {
    const { state, effects } = run([press, { type: "escape" }]);
    expect(state).toEqual(IDLE);
    expect(effects).toEqual([]);
  });

  it("ends a drag at once when the pointer is lost", () => {
    const { state, effects } = run([press, far("a"), { type: "lost" }]);
    expect(state).toEqual(IDLE);
    expect(effects).toEqual([{ kind: "cancel" }]);
  });

  it("ignores moves and releases while idle", () => {
    const { state, effects } = run([
      { type: "move", x: 99, y: 99, over: "a" },
      { type: "release", x: 99, y: 99, over: "a" },
    ]);
    expect(state).toEqual(IDLE);
    expect(effects).toEqual([]);
  });

  it("starts with no valid target when none accepts the payload", () => {
    const none: DragEnvironment = { targets: () => ["a"], accepts: () => false };
    const dragged = step(step(IDLE, press, none).state, far("a"), none).state;
    expect(dragged).toMatchObject({ phase: "dragging", valid: [], over: undefined });
  });

  it("highlights valid targets and the one under the pointer", () => {
    const { state } = run([press, far(), { type: "move", x: 30, y: 10, over: "b" }]);

    expect([dropHighlight(state, "a"), dropHighlight(state, "b"), dropHighlight(state, "c")]).toEqual([
      "valid",
      "over",
      "none",
    ]);
    expect(dropHighlight(IDLE, "a")).toBe("none");
  });

  describe("outside the window (#68)", () => {
    const tab: DragPayload = { kind: "tab", id: "t1", label: "Build" };
    const leaving: DragEnvironment = { ...env, leaves: (p) => p.kind === "tab" };
    const runWith = (events: DragEvent[], environment: DragEnvironment) => {
      let state: DragState = IDLE;
      const effects: unknown[] = [];
      for (const event of events) {
        const result = step(state, event, environment);
        state = result.state;
        if (result.effect) effects.push(result.effect);
      }
      return { state, effects };
    };
    const pressTab: DragEvent = { type: "press", payload: tab, x: 10, y: 10 };

    it("marks the drag while the pointer is outside and clears the mark when it comes back", () => {
      const out = runWith(
        [pressTab, { type: "move", x: -40, y: 10, over: undefined, outside: true }],
        leaving,
      );
      expect(out.state).toMatchObject({ phase: "dragging", outside: true, over: undefined });

      const back = step(out.state, { type: "move", x: 30, y: 10, over: "a" }, leaving).state;
      expect(back).toMatchObject({ phase: "dragging", over: "a" });
      expect(back).not.toHaveProperty("outside");
    });

    it("hands a release outside to the main process when the payload may leave the window", () => {
      const { state, effects } = runWith(
        [
          pressTab,
          { type: "move", x: -40, y: 10, over: undefined, outside: true },
          { type: "release", x: -60, y: 12, over: undefined, outside: true },
        ],
        leaving,
      );
      expect(state).toEqual(IDLE);
      expect(effects).toEqual([{ kind: "outside", payload: tab, x: -60, y: 12 }]);
    });

    it("cancels a release outside for a payload that stays in its window", () => {
      const { effects } = runWith(
        [press, far(), { type: "release", x: -60, y: 12, over: undefined, outside: true }],
        leaving,
      );
      expect(effects).toEqual([{ kind: "cancel" }]);
    });

    it("cancels a release outside without a rule for leaving", () => {
      const { effects } = runWith(
        [pressTab, far(), { type: "release", x: -60, y: 12, over: undefined, outside: true }],
        env,
      );
      expect(effects).toEqual([{ kind: "cancel" }]);
    });

    it("aborts with Esc outside, and the release afterwards hands nothing over", () => {
      const { effects } = runWith(
        [
          pressTab,
          { type: "move", x: -40, y: 10, over: undefined, outside: true },
          { type: "escape" },
          { type: "release", x: -60, y: 12, over: undefined, outside: true },
        ],
        leaving,
      );
      expect(effects).toEqual([{ kind: "cancel" }]);
    });
  });

  it("counts a drag and an abort as a gesture that must not click", () => {
    expect(isDragGesture(run([press, far()]).state)).toBe(true);
    expect(isDragGesture({ phase: "aborted" })).toBe(true);
    expect(isDragGesture(run([press]).state)).toBe(false);
    expect(isDragGesture(IDLE)).toBe(false);
  });
});
