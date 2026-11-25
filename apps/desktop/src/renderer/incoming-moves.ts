// The target side of a move between windows (#68): puts the item in, waits until every pane it put in is attached
// (or shows a placeholder), answers the main process, and takes the panes out again when it refuses or the main
// process cancels. Free of DOM and React; `App.tsx` feeds it the events and the outcomes of the panes.
import type { BridgeEvent, TransferItem, TransferPane } from "../shared/bridge.js";
import type { MoveTarget } from "./layout-moves.js";
import type { UiStore } from "./ui-store.js";
import { settleIncoming, startIncoming } from "./window-transfer.js";
import type { IncomingTransfer, PaneOutcome } from "./window-transfer.js";

/** How long an answered move can still be cancelled: the main process gives up after 75 s. */
export const ANSWERED_KEEP_MS = 80_000;

export interface IncomingMovesDeps {
  store: Pick<UiStore, "receive" | "dropIncoming">;
  /** `transferAttached`; `views` undefined refuses. */
  answer(transferId: string, views: TransferPane[] | undefined): void;
  schedule?(run: () => void, ms: number): () => void;
}

export class IncomingMoves {
  private readonly pending = new Map<string, IncomingTransfer>();
  /** Moves answered with views: the main process may still cancel them while it hands the writers over. */
  private readonly answered = new Map<string, { panes: string[]; stop: () => void }>();
  private readonly schedule: (run: () => void, ms: number) => () => void;

  constructor(private readonly deps: IncomingMovesDeps) {
    this.schedule =
      deps.schedule ??
      ((run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      });
  }

  /** `transferIn`: the item at `target` (undefined: no valid target there), or a refusal at once. */
  receive(transferId: string, item: TransferItem, target: MoveTarget | undefined): void {
    if (this.pending.has(transferId) || this.answered.has(transferId)) return;
    const panes = target && this.deps.store.receive(item, target);
    if (!panes) {
      this.deps.answer(transferId, undefined);
      return;
    }
    this.pending.set(transferId, startIncoming(transferId, panes));
  }

  /** A pane of this window attached, failed to, or shows a placeholder; panes of no move are ignored. */
  settle(paneId: string, outcome: PaneOutcome): void {
    for (const [transferId, transfer] of this.pending) {
      if (!(paneId in transfer.panes)) continue;
      const { transfer: next, result } = settleIncoming(transfer, paneId, outcome);
      if (!result) {
        this.pending.set(transferId, next);
        return;
      }
      this.pending.delete(transferId);
      const panes = Object.keys(next.panes);
      if (result === "refused") {
        this.deps.store.dropIncoming(panes);
        this.deps.answer(transferId, undefined);
        return;
      }
      const stop = this.schedule(() => this.answered.delete(transferId), ANSWERED_KEEP_MS);
      this.answered.set(transferId, { panes, stop });
      this.deps.answer(transferId, result.views);
      return;
    }
  }

  /** `transferCancel`: the panes of the move leave this window again (their views read, nothing else changes). */
  cancel(transferId: string): void {
    const waiting = this.pending.get(transferId);
    const answered = this.answered.get(transferId);
    this.pending.delete(transferId);
    this.answered.delete(transferId);
    answered?.stop();
    const panes = waiting ? Object.keys(waiting.panes) : answered?.panes;
    if (panes) this.deps.store.dropIncoming(panes);
  }

  dispose(): void {
    for (const { stop } of this.answered.values()) stop();
    this.answered.clear();
    this.pending.clear();
  }
}

/** The events of moves between windows. */
export type TransferEvent = Extract<
  BridgeEvent,
  { kind: "transferHover" | "transferIn" | "transferCancel" | "transferOut" }
>;

export function isTransferEvent(event: BridgeEvent): event is TransferEvent {
  return (
    event.kind === "transferHover" ||
    event.kind === "transferIn" ||
    event.kind === "transferCancel" ||
    event.kind === "transferOut"
  );
}

/**
 * Holds the events of moves until the window can handle them: a new window gets its item right after it has asked
 * for its layout, before it shows its panes and drop targets. Hovers that wait are dropped, only the last counts.
 */
export class TransferInbox {
  private queued: TransferEvent[] = [];
  private handler: ((event: TransferEvent) => void) | undefined;

  push(event: TransferEvent): void {
    if (this.handler) {
      this.handler(event);
      return;
    }
    if (event.kind === "transferHover")
      this.queued = this.queued.filter((each) => each.kind !== "transferHover");
    this.queued.push(event);
  }

  /** Hands the waiting events to `handler`, then every new one; the returned function stops that. */
  listen(handler: (event: TransferEvent) => void): () => void {
    this.handler = handler;
    const waiting = this.queued;
    this.queued = [];
    for (const event of waiting) handler(event);
    return () => {
      if (this.handler === handler) this.handler = undefined;
    };
  }
}
