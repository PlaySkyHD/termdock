// Drag and drop by pointer events, the part that listens (#63): feeds the pure machine (`drag-model.ts`) from the
// events of a window and reports what it does. Window and hit test are injected, so a test drives it with fake
// events. Free of React.
import { IDLE, isDragGesture, step } from "./drag-model.js";
import type { DragEnvironment, DragEvent, DragPayload, DragState } from "./drag-model.js";

/** The fields of a pointer or key event the controller reads. A DOM event fits it. */
export interface DragEventLike {
  clientX?: number;
  clientY?: number;
  button?: number;
  key?: string;
  preventDefault(): void;
  stopPropagation(): void;
}

/** The window (or any event target) the controller listens on. */
export interface DragHost {
  addEventListener(type: string, listener: (event: DragEventLike) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: DragEventLike) => void, capture?: boolean): void;
}

export interface DragControllerOptions extends DragEnvironment {
  host: DragHost;
  /** Id of the drop target under the point (the DOM: `elementFromPoint(...).closest("[data-drop-target]")`). */
  hit(x: number, y: number): string | undefined;
  /** The state changed: render the highlight and the ghost. */
  onChange(state: DragState): void;
  /** Released over a valid target. */
  onDrop(payload: DragPayload, targetId: string): void;
  /** A drag ended without a drop. */
  onCancel?(): void;
  /** Runs `run` after the current event is done (`setTimeout(run, 0)`); ends the suppression of the click. */
  defer?(run: () => void): void;
  /** Toggles the look of a running drag on the page (cursor, no text selection). */
  setDragging?(active: boolean): void;
}

export class DragController {
  private state: DragState = IDLE;
  private listening = false;
  private readonly defer: (run: () => void) => void;

  constructor(private readonly options: DragControllerOptions) {
    this.defer = options.defer ?? ((run) => void setTimeout(run, 0));
  }

  getState(): DragState {
    return this.state;
  }

  /** The primary button went down on a source. Call from its `pointerdown`. */
  press(payload: DragPayload, event: Pick<DragEventLike, "clientX" | "clientY" | "button">): void {
    if ((event.button ?? 0) !== 0 || this.state.phase !== "idle") return;
    this.listen();
    this.apply({ type: "press", payload, x: event.clientX ?? 0, y: event.clientY ?? 0 });
  }

  /** Stops listening and drops a running drag without a drop (the sidebar unmounts). */
  dispose(): void {
    if (this.state.phase === "dragging") this.options.onCancel?.();
    this.unlisten();
    this.set(IDLE);
  }

  private readonly onMove = (event: DragEventLike): void => {
    const [x, y] = point(event);
    this.apply({ type: "move", x, y, over: this.options.hit(x, y) });
  };

  private readonly onUp = (event: DragEventLike): void => {
    const [x, y] = point(event);
    const gesture = isDragGesture(this.state);
    this.apply({ type: "release", x, y, over: this.options.hit(x, y) });
    if (gesture) this.swallowClick();
  };

  private readonly onLost = (): void => this.apply({ type: "lost" });

  private readonly onKey = (event: DragEventLike): void => {
    if (event.key !== "Escape" || this.state.phase === "idle") return;
    // The key belongs to the drag: it must not reach the terminal or close a dialog behind it.
    if (isDragGesture(this.state)) {
      event.preventDefault();
      event.stopPropagation();
    }
    this.apply({ type: "escape" });
  };

  /** The `click` that follows the release of a drag must not open the session under the pointer. */
  private swallowClick(): void {
    const stop = (event: DragEventLike): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    this.options.host.addEventListener("click", stop, true);
    // `click` comes right after `pointerup`; a drag that ends elsewhere has none, so the guard must not stay.
    this.defer(() => this.options.host.removeEventListener("click", stop, true));
  }

  private apply(event: DragEvent): void {
    const { state, effect } = step(this.state, event, this.options);
    this.set(state);
    if (state.phase === "idle") this.unlisten();
    if (effect?.kind === "drop") this.options.onDrop(effect.payload, effect.targetId);
    else if (effect?.kind === "cancel") this.options.onCancel?.();
  }

  private set(state: DragState): void {
    const wasDragging = this.state.phase === "dragging";
    this.state = state;
    if (wasDragging !== (state.phase === "dragging")) this.options.setDragging?.(state.phase === "dragging");
    this.options.onChange(state);
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    const { host } = this.options;
    host.addEventListener("pointermove", this.onMove, true);
    host.addEventListener("pointerup", this.onUp, true);
    host.addEventListener("pointercancel", this.onLost, true);
    // Not captured: `blur` does not bubble, so this hears only the window losing the focus, not a field inside it
    // (a press moves the focus from the terminal to the button).
    host.addEventListener("blur", this.onLost);
    host.addEventListener("keydown", this.onKey, true);
  }

  private unlisten(): void {
    if (!this.listening) return;
    this.listening = false;
    const { host } = this.options;
    host.removeEventListener("pointermove", this.onMove, true);
    host.removeEventListener("pointerup", this.onUp, true);
    host.removeEventListener("pointercancel", this.onLost, true);
    host.removeEventListener("blur", this.onLost);
    host.removeEventListener("keydown", this.onKey, true);
  }
}

function point(event: DragEventLike): [number, number] {
  return [event.clientX ?? 0, event.clientY ?? 0];
}
