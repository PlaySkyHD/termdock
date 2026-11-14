import { describe, expect, it } from "vitest";
import { DragController } from "./drag-controller.js";
import type { DragEventLike, DragHost } from "./drag-controller.js";
import type { DragPayload, DragState } from "./drag-model.js";

type Listener = (event: DragEventLike) => void;

/** Window double: keeps the listeners by type and fires events to them (capture or not is not modelled). */
class FakeHost implements DragHost {
  readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
  count(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
  /** Fires the event; returns whether a listener stopped it. */
  fire(type: string, init: Partial<DragEventLike> = {}): { stopped: boolean; prevented: boolean } {
    const flags = { stopped: false, prevented: false };
    const event: DragEventLike = {
      ...init,
      preventDefault: () => void (flags.prevented = true),
      stopPropagation: () => void (flags.stopped = true),
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    return flags;
  }
}

const payload: DragPayload = { kind: "session", id: "s1", label: "Build" };

function setup(over: { current: string | undefined } = { current: undefined }) {
  const host = new FakeHost();
  const states: DragState[] = [];
  const drops: Array<[DragPayload, string]> = [];
  const log = { cancels: 0, dragging: [] as boolean[], deferred: [] as Array<() => void> };
  const controller = new DragController({
    host,
    hit: () => over.current,
    targets: () => ["a", "b"],
    accepts: (_payload, id) => id === "a",
    onChange: (state) => states.push(state),
    onDrop: (p, id) => drops.push([p, id]),
    onCancel: () => void (log.cancels += 1),
    defer: (run) => log.deferred.push(run),
    setDragging: (active) => log.dragging.push(active),
  });
  const phase = (): string => controller.getState().phase;
  return { host, controller, states, drops, log, over, phase };
}

const down = { clientX: 10, clientY: 10, button: 0 };
const move = (x: number): Partial<DragEventLike> => ({ clientX: x, clientY: 10 });

describe("DragController", () => {
  it("listens only while a gesture runs", () => {
    const { host, controller } = setup();
    expect(host.count()).toBe(0);

    controller.press(payload, down);
    expect(host.count()).toBeGreaterThan(0);

    host.fire("pointerup", move(10));
    expect(host.count()).toBe(0);
  });

  it("ignores a press with another button than the primary one", () => {
    const { host, controller, phase } = setup();
    controller.press(payload, { ...down, button: 2 });
    expect(phase()).toBe("idle");
    expect(host.count()).toBe(0);
  });

  it("drops on a valid target and swallows the click that follows the release", () => {
    const over = { current: "a" as string | undefined };
    const { host, controller, drops, log } = setup(over);

    controller.press(payload, down);
    host.fire("pointermove", move(30));
    host.fire("pointerup", move(30));

    expect(drops).toEqual([[payload, "a"]]);
    const click = host.fire("click");
    expect(click).toEqual({ stopped: true, prevented: true });
    // The guard is removed once the click is through (it would never come after a drag elsewhere).
    for (const run of log.deferred) run();
    expect(host.fire("click")).toEqual({ stopped: false, prevented: false });
  });

  it("does not swallow the click of a press that never became a drag", () => {
    const { host, controller, drops } = setup({ current: "a" });

    controller.press(payload, down);
    host.fire("pointermove", move(12));
    host.fire("pointerup", move(12));

    expect(drops).toEqual([]);
    expect(host.fire("click")).toEqual({ stopped: false, prevented: false });
  });

  it("cancels on Esc, keeps the key from everything else, and swallows the click after the release", () => {
    const { host, controller, drops, log, phase } = setup({ current: "a" });

    controller.press(payload, down);
    host.fire("pointermove", move(30));
    const esc = host.fire("keydown", { key: "Escape" });
    expect(esc).toEqual({ stopped: true, prevented: true });
    expect(phase()).toBe("aborted");
    expect(log.cancels).toBe(1);

    host.fire("pointermove", move(40));
    host.fire("pointerup", move(40));

    expect(drops).toEqual([]);
    expect(host.fire("click").stopped).toBe(true);
    expect(phase()).toBe("idle");
  });

  it("leaves Esc alone when no drag is running", () => {
    const { host, controller } = setup();

    controller.press(payload, down);
    const esc = host.fire("keydown", { key: "Escape" });

    expect(esc).toEqual({ stopped: false, prevented: false });
  });

  it("ignores other keys", () => {
    const { host, controller, phase } = setup({ current: "a" });
    controller.press(payload, down);
    host.fire("pointermove", move(30));

    host.fire("keydown", { key: "a" });

    expect(phase()).toBe("dragging");
  });

  it.each(["pointercancel", "blur"])("cancels at once on %s and stops listening", (type) => {
    const { host, controller, log, drops, phase } = setup({ current: "a" });
    controller.press(payload, down);
    host.fire("pointermove", move(30));

    host.fire(type);

    expect(phase()).toBe("idle");
    expect(log.cancels).toBe(1);
    expect(drops).toEqual([]);
    expect(host.count()).toBe(0);
  });

  it("switches the look of a running drag on and off with the drag", () => {
    const { host, controller, log } = setup({ current: "a" });

    controller.press(payload, down);
    host.fire("pointermove", move(30));
    host.fire("pointerup", move(30));

    expect(log.dragging).toEqual([true, false]);
  });

  it("reports the highlight with every change", () => {
    const { host, controller, states } = setup({ current: "a" });

    controller.press(payload, down);
    host.fire("pointermove", move(30));

    expect(states.at(-1)).toMatchObject({ phase: "dragging", valid: ["a"], over: "a" });
  });

  it("drops a running drag without a drop on dispose and removes its listeners", () => {
    const { host, controller, log, drops, phase } = setup({ current: "a" });
    controller.press(payload, down);
    host.fire("pointermove", move(30));

    controller.dispose();

    expect(phase()).toBe("idle");
    expect(log.cancels).toBe(1);
    expect(drops).toEqual([]);
    expect(host.count()).toBe(0);
  });

  it("ignores a second press while a gesture runs", () => {
    const { host, controller } = setup({ current: "a" });
    controller.press(payload, down);
    host.fire("pointermove", move(30));

    controller.press({ kind: "session", id: "other" }, down);

    expect(controller.getState()).toMatchObject({ phase: "dragging", payload });
  });
});
