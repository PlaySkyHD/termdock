// Moving a tab or a pane to another window (#68, ADR 0006): the main process follows the drag beyond the source
// window, shows it in the window under the pointer and hands the views over. The target attaches new views (they
// read while the old ones are there), this process moves each writer to its successor with `session.claimWriter`,
// and only then does the source take the item out and detach its views. So the core sees one attach and one detach
// per view, never two writers and never none where there was one. Free of Electron: windows, screen and core are
// behind `TransferHost`.
import type {
  BridgeEvent,
  ClientPoint,
  TransferItem,
  TransferSource,
  TransferPane,
} from "../shared/bridge.js";
import type { LayoutWindow } from "@termdock/protocol";

/** A point on the screen in DIP, as Electron gives window bounds. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** Longest wait for the target's answer: above the 60 s of `session.attach` (ADR 0006). */
export const TRANSFER_TIMEOUT_MS = 75_000;

/** What the coordinator needs of the windows, the screen and the core (`main.ts` with Electron, a fake in tests). */
export interface TransferHost {
  /** The screen point of a point in the client area of the window; undefined for a window that is gone. */
  toScreen(windowId: number, point: ClientPoint): ScreenPoint | undefined;
  toClient(windowId: number, point: ScreenPoint): ClientPoint | undefined;
  /** The topmost window of the app whose frame contains the point, or undefined. */
  windowAt(point: ScreenPoint): number | undefined;
  /** Opens a window with no tabs at the point; undefined at the limit of windows. */
  openWindowAt(point: ScreenPoint): number | undefined;
  moveWindowTo(windowId: number, point: ScreenPoint): void;
  /** Closes a window the way the user does; it is not the last one, so no quit dialog, and it leaves the layout. */
  closeWindow(windowId: number): void;
  /** The layout the window reported last (`LayoutCoordinator.windowOf`); undefined for an unknown window. */
  layoutOf(windowId: number): LayoutWindow | undefined;
  send(windowId: number, event: BridgeEvent): boolean;
  /** The session of a view of the window; undefined for a view the window does not have (any more). */
  sessionOf(windowId: number, viewId: string): string | undefined;
  /** Whether the view belongs to the window and is the writer of its session right now. */
  isWriter(windowId: number, viewId: string): boolean;
  /** `session.claimWriter` for a view of the window; rejects for a view of another window. */
  claimWriter(windowId: number, viewId: string): Promise<void>;
  /** Runs `run` after `ms`; the returned function cancels it. */
  schedule(run: () => void, ms: number): () => void;
  newId(): string;
  log(text: string): void;
}

interface Transfer {
  id: string;
  source: number;
  target: number;
  item: TransferItem;
  /** This process opened the target for the move; it closes it again when the move does not happen. */
  created: boolean;
  /** The target has not loaded its layout yet; `transferIn` waits for it. */
  waiting: boolean;
  stopTimer: () => void;
}

export class WindowTransfers {
  private readonly transfers = new Map<string, Transfer>();
  /** The window each source window shows its drag in right now. */
  private readonly hovers = new Map<number, number>();

  constructor(private readonly host: TransferHost) {}

  /** The pointer of a drag of `source` is at `point` outside its window: show it in the window under it. */
  hover(source: number, item: TransferItem, point: ClientPoint): void {
    const screen = this.host.toScreen(source, point);
    const under = screen && this.host.windowAt(screen);
    const target = under === source ? undefined : under;
    const before = this.hovers.get(source);
    if (before !== undefined && before !== target) this.host.send(before, { kind: "transferHover" });
    if (target === undefined || !screen) {
      this.hovers.delete(source);
      return;
    }
    const at = this.host.toClient(target, screen);
    if (!at) return;
    this.hovers.set(source, target);
    this.host.send(target, { kind: "transferHover", hover: { item, x: at.x, y: at.y } });
  }

  /** The drag of `source` came back, ended or was aborted: no other window shows it any more. */
  hoverEnd(source: number): void {
    const before = this.hovers.get(source);
    this.hovers.delete(source);
    if (before !== undefined) this.host.send(before, { kind: "transferHover" });
  }

  /**
   * Released outside the source window. Over another window the item goes there; over the source's own frame
   * nothing happens; elsewhere a new window opens at the pointer, unless the item is the whole source window
   * (`whole`), which then moves there itself.
   */
  drop(source: number, item: TransferItem, point: ClientPoint, whole: boolean): void {
    this.hoverEnd(source);
    const screen = this.host.toScreen(source, point);
    if (!screen || this.inFlight(source, item)) {
      this.host.log(`move from window ${source}: ${screen ? "item already on its way" : "window gone"}`);
      return;
    }
    const under = this.host.windowAt(screen);
    if (under === source) return;
    if (under === undefined && whole) {
      this.host.moveWindowTo(source, screen);
      return;
    }
    const target = under ?? this.host.openWindowAt(screen);
    if (target === undefined) {
      this.host.log(`move from window ${source}: no window could open at ${screen.x},${screen.y}`);
      return;
    }
    const id = this.host.newId();
    const transfer: Transfer = {
      id,
      source,
      target,
      item,
      created: under === undefined,
      waiting: under === undefined,
      stopTimer: this.host.schedule(() => this.cancel(transfer, "no answer in time"), TRANSFER_TIMEOUT_MS),
    };
    this.transfers.set(id, transfer);
    if (!transfer.waiting) this.deliver(transfer, this.host.toClient(target, screen));
  }

  /** The window's page has loaded its layout (`windowLayout`): a new window can take its item now. */
  ready(windowId: number): void {
    for (const transfer of this.transfers.values())
      if (transfer.target === windowId && transfer.waiting) {
        transfer.waiting = false;
        this.deliver(transfer, undefined);
      }
  }

  /**
   * The target's answer: the new view of each source pane once all of its panes are attached, or `undefined` when
   * it refused. Hands each writer over, then lets the source take the item out (or closes it when its last reported
   * layout holds nothing else). A missing successor or a failed claim cancels and gives every writer back.
   */
  async attached(
    windowId: number,
    transferId: string,
    views: readonly TransferPane[] | undefined,
  ): Promise<void> {
    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.target !== windowId || transfer.waiting) return;
    this.forget(transfer);
    if (views === undefined) {
      if (transfer.created) this.host.closeWindow(transfer.target);
      return;
    }
    const claimed: string[] = [];
    for (const { paneId, viewId } of transfer.item.views) {
      const successor = views.find((view) => view.paneId === paneId);
      try {
        // The bridge forgot the view (a restart of the core, the session archived): its role is unknown, so
        // nothing may be handed over or detached on the strength of it (review PR #190).
        const session = this.host.sessionOf(transfer.source, viewId);
        if (session === undefined) throw new Error(`the source's view ${viewId} is gone`);
        if (!successor) throw new Error(`no answer for pane ${paneId}`);
        // A placeholder: the session ended and runs nothing that could write; the old view just goes.
        if (successor.viewId === undefined) continue;
        if (this.host.sessionOf(transfer.target, successor.viewId) !== session)
          throw new Error(
            `view ${successor.viewId} of the target does not show the session of pane ${paneId}`,
          );
        if (!this.host.isWriter(transfer.source, viewId)) continue;
        await this.host.claimWriter(transfer.target, successor.viewId);
        claimed.push(viewId);
      } catch (error) {
        // Back to the source's views, so it keeps every role it had.
        for (const back of claimed)
          await this.host.claimWriter(transfer.source, back).catch((failure: unknown) => {
            this.host.log(`move ${transfer.id}: writer not given back: ${String(failure)}`);
          });
        this.cancel(transfer, error instanceof Error ? error.message : String(error));
        return;
      }
    }
    // Judged now, not at the drop: the window may have got more tabs while the target attached.
    const source = sourceOf(transfer.item);
    if (holdsOnly(this.host.layoutOf(transfer.source), source)) this.host.closeWindow(transfer.source);
    else this.host.send(transfer.source, { kind: "transferOut", source });
  }

  /**
   * The core connection ended (#130): the views every move named belong to a core that is gone, and the windows
   * attach new ones. Every move stops; the target takes out what it put in.
   */
  coreClosed(): void {
    for (const transfer of [...this.transfers.values()]) this.cancel(transfer, "the core connection ended");
  }

  /**
   * A window closed, or its page reloaded or crashed (`reloaded`): moves from or into it stop, and its drag shows
   * nowhere any more. The first load of a window opened for a move is a navigation too; that move keeps waiting.
   */
  windowGone(windowId: number, reloaded = false): void {
    this.hoverEnd(windowId);
    for (const [source, target] of this.hovers) if (target === windowId) this.hovers.delete(source);
    for (const transfer of [...this.transfers.values()]) {
      if (transfer.target === windowId && reloaded && transfer.waiting) continue;
      if (transfer.target === windowId) this.forget(transfer);
      else if (transfer.source === windowId) this.cancel(transfer, "the source window closed");
    }
  }

  private inFlight(source: number, item: TransferItem): boolean {
    const key = JSON.stringify(sourceOf(item));
    return [...this.transfers.values()].some(
      (each) => each.source === source && JSON.stringify(sourceOf(each.item)) === key,
    );
  }

  private deliver(transfer: Transfer, at: ClientPoint | undefined): void {
    this.host.send(transfer.target, {
      kind: "transferIn",
      transferId: transfer.id,
      item: transfer.item,
      ...(at === undefined ? {} : { at }),
    });
  }

  private forget(transfer: Transfer): void {
    transfer.stopTimer();
    this.transfers.delete(transfer.id);
  }

  /** The target takes out what it put in (its views read); a window opened for the move closes again. */
  private cancel(transfer: Transfer, reason: string): void {
    this.forget(transfer);
    this.host.log(`move ${transfer.id} cancelled: ${reason}`);
    if (!transfer.waiting)
      this.host.send(transfer.target, { kind: "transferCancel", transferId: transfer.id });
    if (transfer.created) this.host.closeWindow(transfer.target);
  }
}

/** Whether the window holds nothing but the item: one tab that is it, or whose only pane it is. */
export function holdsOnly(window: LayoutWindow | undefined, source: TransferSource): boolean {
  const only = window?.tabs.length === 1 ? window.tabs[0] : undefined;
  if (!only) return false;
  return source.kind === "tab"
    ? only.id === source.tabId
    : only.root.kind === "pane" && only.root.id === source.paneId;
}

function sourceOf(item: TransferItem): TransferSource {
  return item.kind === "tab" ? { kind: "tab", tabId: item.tab.id } : { kind: "pane", paneId: item.pane.id };
}
