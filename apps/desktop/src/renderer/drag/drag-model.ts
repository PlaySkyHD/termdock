// Drag and drop by pointer events, the pure part (#63): a state machine from press to drop, with the rules for
// which targets are valid. Free of DOM and React, so the highlight, the threshold, Esc and the drop are tested
// without a window. The sidebar moves sessions with it; tabs and panes (#67) bring their own payload kinds and
// targets and reuse everything else. Native HTML5 dragging is not used: it runs a loop of the operating system
// that `webContents.sendInputEvent` cannot drive, and it has no key to abort.

/** What is dragged. `kind` tells the targets what they get (today `session`; `tab` and `pane` follow in #67). */
export interface DragPayload {
  kind: string;
  id: string;
  /** Text of the ghost that follows the pointer. */
  label?: string;
}

/** Pixels the pointer must move from the press before a press becomes a drag; less is a click. */
export const DRAG_THRESHOLD_PX = 5;

export type DragState =
  | { phase: "idle" }
  /** The button is down, the pointer has not moved far enough yet. */
  | { phase: "pressed"; payload: DragPayload; startX: number; startY: number }
  | {
      phase: "dragging";
      payload: DragPayload;
      x: number;
      y: number;
      /** Every target that accepts the payload: all of them are highlighted while dragging. */
      valid: readonly string[];
      /** The valid target under the pointer, highlighted additionally. */
      over: string | undefined;
    }
  /** Aborted with Esc: nothing is highlighted, the release that ends the gesture does nothing. */
  | { phase: "aborted" };

export const IDLE: DragState = { phase: "idle" };

/** What the DOM tells the machine. `over` is the id of the drop target under the pointer, valid or not. */
export type DragEvent =
  | { type: "press"; payload: DragPayload; x: number; y: number }
  | { type: "move"; x: number; y: number; over: string | undefined }
  | { type: "release"; x: number; y: number; over: string | undefined }
  /** Esc: aborts a drag, drops a press. */
  | { type: "escape" }
  /** The pointer is gone (`pointercancel`, `blur`): ends everything at once. */
  | { type: "lost" };

/** What the machine can read of the world. */
export interface DragEnvironment {
  /** Ids of all drop targets that exist now. */
  targets(): readonly string[];
  accepts(payload: DragPayload, targetId: string): boolean;
}

export type DragEffect =
  /** Released over a valid target: do it. */
  | { kind: "drop"; payload: DragPayload; targetId: string }
  /** A drag ended without a drop (Esc, released elsewhere or over an invalid target, pointer lost). */
  | { kind: "cancel" };

export interface DragStep {
  state: DragState;
  effect?: DragEffect;
}

const stay = (state: DragState): DragStep => ({ state });

/** The next state and what to do about it. Pure. */
export function step(state: DragState, event: DragEvent, env: DragEnvironment): DragStep {
  switch (event.type) {
    case "press":
      return stay({ phase: "pressed", payload: event.payload, startX: event.x, startY: event.y });
    case "move": {
      if (state.phase === "pressed") {
        if (Math.hypot(event.x - state.startX, event.y - state.startY) < DRAG_THRESHOLD_PX)
          return stay(state);
        const valid = env.targets().filter((id) => env.accepts(state.payload, id));
        return stay(dragging(state.payload, event.x, event.y, event.over, valid));
      }
      if (state.phase === "dragging")
        return stay(dragging(state.payload, event.x, event.y, event.over, state.valid));
      return stay(state);
    }
    case "release": {
      if (state.phase === "dragging") {
        const over = event.over;
        // The target is judged again at the release: the sidebar may have changed while the pointer moved.
        if (over !== undefined && env.accepts(state.payload, over))
          return { state: IDLE, effect: { kind: "drop", payload: state.payload, targetId: over } };
        return { state: IDLE, effect: { kind: "cancel" } };
      }
      // A press that never became a drag is a click; after Esc the release only ends the gesture.
      return stay(IDLE);
    }
    case "escape":
      if (state.phase === "dragging") return { state: { phase: "aborted" }, effect: { kind: "cancel" } };
      return stay(state.phase === "pressed" ? IDLE : state);
    case "lost":
      return state.phase === "dragging" ? { state: IDLE, effect: { kind: "cancel" } } : stay(IDLE);
  }
}

function dragging(
  payload: DragPayload,
  x: number,
  y: number,
  over: string | undefined,
  valid: readonly string[],
): DragState {
  return {
    phase: "dragging",
    payload,
    x,
    y,
    valid,
    over: over !== undefined && valid.includes(over) ? over : undefined,
  };
}

/** A drag is in progress: a gesture that must not be taken for a click (also after Esc until the release). */
export function isDragGesture(state: DragState): boolean {
  return state.phase === "dragging" || state.phase === "aborted";
}

/** How a drop target looks right now: a valid target of the running drag, the one under the pointer, or neither. */
export function dropHighlight(state: DragState, targetId: string): "over" | "valid" | "none" {
  if (state.phase !== "dragging") return "none";
  if (state.over === targetId) return "over";
  return state.valid.includes(targetId) ? "valid" : "none";
}
