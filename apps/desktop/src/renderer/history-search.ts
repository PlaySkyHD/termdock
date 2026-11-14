// Logic of the history search dialog (#62, Ctrl+Shift+F): when a search starts, which answer counts, how hits are
// grouped by session and where the match lies in a line. Pure, no DOM, so it is unit-tested. Terminal output is
// data: a hit line is only ever shown as text, never interpreted.
import { MAX_HISTORY_QUERY_LENGTH } from "@termdock/protocol";
import type { HistoryHit, SessionId, SessionInfo, SessionState } from "@termdock/protocol";
import type { TermdockApi } from "../shared/bridge.js";

/** Pause after the last keystroke before the search starts. */
export const SEARCH_DELAY_MS = 250;
/** Hits the dialog asks for; the core never answers with more than 200. */
export const SEARCH_LIMIT = 100;

export const QUERY_TOO_LONG = `Höchstens ${MAX_HISTORY_QUERY_LENGTH} Zeichen`;
export const DELETED_SESSION = "Gelöschte Session";

/** The hits of one session, newest first. */
export interface HitGroup {
  sessionId: SessionId;
  /** Name of the session; `DELETED_SESSION` when the list of sessions does not have it (any more). */
  name: string;
  /** Undefined when the session is unknown. */
  state: SessionState | undefined;
  hits: HistoryHit[];
}

/** Groups in the order of their newest hit (the core answers newest first); hits keep their order. */
export function groupHits(hits: readonly HistoryHit[], sessions: readonly SessionInfo[]): HitGroup[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const groups = new Map<SessionId, HitGroup>();
  for (const hit of hits) {
    let group = groups.get(hit.sessionId);
    if (!group) {
      const session = byId.get(hit.sessionId);
      group = {
        sessionId: hit.sessionId,
        name: session?.name ?? DELETED_SESSION,
        state: session?.state,
        hits: [],
      };
      groups.set(hit.sessionId, group);
    }
    group.hits.push(hit);
  }
  return [...groups.values()];
}

/** A hit line cut at the match: the match itself is highlighted, the rest is shown as it is. */
export function splitHit(hit: HistoryHit, query: string): { before: string; match: string; after: string } {
  const start = Math.min(Math.max(0, hit.offset), hit.line.length);
  const end = Math.min(hit.line.length, start + query.length);
  return { before: hit.line.slice(0, start), match: hit.line.slice(start, end), after: hit.line.slice(end) };
}

/** Date and time of a hit like `14.11.2026, 21:05:09`, in the time zone of the user. */
export function formatHitTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("de-DE", { hour12: false });
}

export type SearchView =
  | { status: "idle" }
  | { status: "searching"; query: string }
  | { status: "done"; query: string; groups: HitGroup[]; total: number; truncated: boolean }
  | { status: "error"; query: string; message: string };

const IDLE: SearchView = { status: "idle" };

export interface SearchTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: SearchTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * State of one open dialog. `setQuery` waits `SEARCH_DELAY_MS` after the last change; `run` searches at once
 * (Enter). Only the answer of the newest search counts, so a slow answer never replaces a newer one. `dispose`
 * ends everything when the dialog closes.
 */
export class HistorySearchModel {
  private view: SearchView = IDLE;
  private timer: unknown;
  private generation = 0;
  private disposed = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly api: Pick<TermdockApi, "searchHistory">,
    private readonly sessions: () => readonly SessionInfo[],
    private readonly timers: SearchTimers = REAL_TIMERS,
  ) {}

  getState = (): SearchView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  setQuery(raw: string): void {
    this.cancelTimer();
    const query = raw.trim();
    if (query === "") {
      this.generation++;
      this.set(IDLE);
      return;
    }
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      void this.run(query);
    }, SEARCH_DELAY_MS);
  }

  /** Searches now. An empty query clears the result; one that is too long is refused here. */
  async run(raw: string): Promise<void> {
    this.cancelTimer();
    const query = raw.trim();
    const generation = ++this.generation;
    if (query === "") {
      this.set(IDLE);
      return;
    }
    if (query.length > MAX_HISTORY_QUERY_LENGTH) {
      this.set({ status: "error", query, message: QUERY_TOO_LONG });
      return;
    }
    this.set({ status: "searching", query });
    try {
      const { hits, truncated } = await this.api.searchHistory(query, SEARCH_LIMIT);
      if (generation !== this.generation) return;
      this.set({
        status: "done",
        query,
        groups: groupHits(hits, this.sessions()),
        total: hits.length,
        truncated,
      });
    } catch (error) {
      if (generation !== this.generation) return;
      this.set({ status: "error", query, message: error instanceof Error ? error.message : String(error) });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.cancelTimer();
    this.listeners.clear();
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  private set(view: SearchView): void {
    if (this.disposed) return;
    this.view = view;
    for (const listener of [...this.listeners]) listener();
  }
}
