// The source side of a move between windows (#68): which drags may leave the window, and what the main process hears
// while the pointer is outside it. The item is built once per drag (the payload object of a drag stays the same), and
// the hovers go out at most once per frame with the latest point: the pointer moves far more often than the target
// can draw. Free of DOM and React; `App.tsx` hands it to the window's `DragProvider` as its `OutsideRules`.
import type { LayoutWindow, ViewId } from "@termdock/protocol";
import type { TermdockApi } from "../shared/bridge.js";
import type { DragPayload } from "./drag/drag-model.js";
import type { OutsideRules } from "./drag/DragProvider.js";
import { outgoingItem } from "./window-transfer.js";

export interface OutgoingMovesDeps {
  window(): LayoutWindow;
  /** The view attached in a pane of this window. */
  viewOf(paneId: string): ViewId | undefined;
  api: Pick<TermdockApi, "transferHover" | "transferHoverEnd" | "transferDrop">;
  /** Runs `run` with the next frame (`requestAnimationFrame`); the returned function cancels it. */
  frame?(run: () => void): () => void;
  onError?(error: unknown): void;
}

type Taken = ReturnType<typeof outgoingItem>;

export class OutgoingMoves implements OutsideRules {
  private taken: { payload: DragPayload; move: Taken } | undefined;
  private pending: { payload: DragPayload; x: number; y: number } | undefined;
  private cancelFrame: (() => void) | undefined;
  private readonly frame: (run: () => void) => () => void;
  private readonly onError: (error: unknown) => void;

  constructor(private readonly deps: OutgoingMovesDeps) {
    this.frame =
      deps.frame ??
      ((run) => {
        const handle = requestAnimationFrame(run);
        return () => cancelAnimationFrame(handle);
      });
    this.onError = deps.onError ?? ((error) => console.error(error));
  }

  leaves(payload: DragPayload): boolean {
    return this.take(payload) !== undefined;
  }

  hover(payload: DragPayload, x: number, y: number): void {
    if (!this.take(payload)) return;
    this.pending = { payload, x, y };
    this.cancelFrame ??= this.frame(() => {
      this.cancelFrame = undefined;
      const latest = this.pending;
      this.pending = undefined;
      const move = latest && this.take(latest.payload);
      if (latest && move)
        this.deps.api.transferHover(move.item, { x: latest.x, y: latest.y }).catch(this.onError);
    });
  }

  end(): void {
    this.cancelFrame?.();
    this.cancelFrame = undefined;
    this.pending = undefined;
    this.deps.api.transferHoverEnd().catch(this.onError);
  }

  drop(payload: DragPayload, x: number, y: number): void {
    const move = this.take(payload);
    this.taken = undefined;
    if (move) this.deps.api.transferDrop(move.item, { x, y }, move.whole).catch(this.onError);
  }

  /** The item of the running drag, built at its first question. */
  private take(payload: DragPayload): Taken {
    if (this.taken?.payload !== payload)
      this.taken = { payload, move: outgoingItem(this.deps.window(), payload, this.deps.viewOf) };
    return this.taken.move;
  }
}
