// Search over the stored history of sessions (spec history, ADR 0004, issue #62). Terminal output is data: the
// escape sequences are removed while reading, never interpreted or executed, lines are put together as the
// terminal showed them (backspace, erase to end of line and carriage return edit the line, issue #102) and the
// plain text is matched case-insensitively. Every resource is bounded: hits (MAX_HISTORY_HITS), characters of a hit line, the line
// buffer while reading and the running time (partial result with `truncated`).
import { MAX_HISTORY_HITS, MAX_HISTORY_LINE_LENGTH } from "@termdock/protocol";
import type { HistoryHit, HistorySearchResult, SessionId } from "@termdock/protocol";
import type { HistoryEntry, HistoryStore } from "./history-store.js";

/** How long one search may run before it ends with a partial result. */
export const DEFAULT_SEARCH_MAX_MS = 5000;
/** Characters of one line kept while reading; a longer line is cut here (the cut keeps an overlap for matches). */
export const MAX_SEARCH_LINE_BUFFER = 4096;
/** An escape string (OSC, DCS ...) or CSI that does not end within this many characters is plain data again. */
const MAX_ESCAPE_RUN = 4096;

/** What the search needs of the history: which sessions have one, and their entries from old to new. */
export interface HistorySearchSource {
  /** Sessions that have a history directory. */
  listSessions(): Promise<SessionId[]>;
  /** Entries of a session from old to new; a missing history yields nothing. */
  read(sessionId: SessionId): AsyncIterable<HistoryEntry>;
}

/** The search source over a store: output queued but not yet written is flushed first, so the newest lines count. */
export function storeSource(store: HistoryStore): HistorySearchSource {
  return {
    async listSessions() {
      // A session that has only queued output has no directory yet.
      await store.flush();
      return store.listSessions();
    },
    async *read(sessionId) {
      await store.flush(sessionId);
      yield* store.read(sessionId);
    },
  };
}

export interface HistorySearchOptions {
  query: string;
  /** Sessions to search; undefined searches every session of the source. */
  sessionIds?: readonly SessionId[];
  /** 1 to MAX_HISTORY_HITS; defaults to MAX_HISTORY_HITS. */
  limit?: number;
  /** Sessions the search may look at; others (a history left behind without a session) are skipped. */
  isKnownSession?: (sessionId: SessionId) => boolean;
  /** Running time limit in ms; defaults to DEFAULT_SEARCH_MAX_MS. */
  maxMs?: number;
  now?: () => number;
}

type Mode = "text" | "escape" | "csi" | "str" | "strEscape" | "escapeIntermediate";

/** Stands for "erase from the cursor to the end of the line" in the stripped text; NUL never occurs in it. */
export const ERASE_TO_EOL = "\0";

/**
 * Removes escape sequences from decoded terminal text, across chunk boundaries: CSI, OSC/DCS/SOS/PM/APC strings
 * (up to BEL or ST), two-character escapes and the C1 forms, plus control characters other than tab, backspace
 * and line breaks. Nothing is ever interpreted or executed: backspace and carriage return stay in the text for
 * the line model of the scanner, and the one CSI it needs (`ESC [ K` or `ESC [ 0 K`, erase to the end of the
 * line) becomes ERASE_TO_EOL; every other sequence is only dropped.
 */
export class AnsiStripper {
  private mode: Mode = "text";
  private run = 0;
  /** Parameter and intermediate characters of the CSI being read (kept only as far as `K` needs them). */
  private csiParams = "";

  push(text: string): string {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      switch (this.mode) {
        case "text":
          if (code === 0x1b) this.enter("escape");
          else if (code === 0x9b) this.enter("csi");
          else if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f)
            this.enter("str");
          else if (
            code === 0x0a ||
            code === 0x0d ||
            code === 0x09 ||
            code === 0x08 ||
            (code >= 0x20 && code < 0x7f) ||
            code > 0x9f
          )
            out += text[i];
          // Other C0 controls, DEL and the remaining C1 controls are dropped.
          break;
        case "escape":
          if (code === 0x5b) this.enter("csi");
          else if (code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f)
            this.enter("str");
          else if (code >= 0x20 && code <= 0x2f) this.enter("escapeIntermediate");
          else if (code !== 0x1b) {
            this.mode = "text";
            // A control character (a line break) after a lone ESC is not part of the sequence.
            if (code < 0x20) i--;
          }
          break;
        case "escapeIntermediate":
          if (code < 0x20 || code > 0x2f) this.mode = "text";
          break;
        case "csi":
          if (code >= 0x40 && code <= 0x7e) {
            // Only "erase from the cursor" (no parameter or 0) is kept; all other sequences just end here.
            if (code === 0x4b && (this.csiParams === "" || this.csiParams === "0")) out += ERASE_TO_EOL;
            this.mode = "text";
          } else if (code === 0x1b) this.enter("escape");
          else if (code === 0x18 || code === 0x1a) this.mode = "text";
          else {
            if (this.csiParams.length < 8) this.csiParams += text[i];
            this.grow();
          }
          break;
        case "str":
          if (code === 0x07 || code === 0x9c) this.mode = "text";
          else if (code === 0x1b) this.mode = "strEscape";
          else this.grow();
          break;
        case "strEscape":
          if (code === 0x5c) this.mode = "text";
          else {
            // Not the end of the string: the escape starts a new sequence, the character belongs to it.
            this.enter("escape");
            i--;
          }
          break;
      }
    }
    return out;
  }

  private enter(mode: Mode): void {
    this.mode = mode;
    this.run = 0;
    this.csiParams = "";
  }

  /** An unterminated sequence must not swallow the rest of the history. */
  private grow(): void {
    if (++this.run > MAX_ESCAPE_RUN) this.mode = "text";
  }
}

interface Candidate {
  hit: HistoryHit;
  /** Order of discovery; breaks ties of the timestamp. */
  seq: number;
}

/** Newest first; within one timestamp the later line first. */
function newerFirst(a: Candidate, b: Candidate): number {
  return b.hit.timestamp - a.hit.timestamp || b.seq - a.seq;
}

/** Keeps the newest hits: memory stays within 2 x limit candidates whatever the history holds. */
class HitCollector {
  private candidates: Candidate[] = [];
  private seq = 0;
  /** True once a hit that is older than all kept ones was discarded. */
  overflowed = false;

  constructor(private readonly limit: number) {}

  add(hit: HistoryHit): void {
    this.candidates.push({ hit, seq: this.seq++ });
    if (this.candidates.length > this.limit * 2) this.trim();
  }

  result(): { hits: HistoryHit[]; overflowed: boolean } {
    this.trim();
    return { hits: this.candidates.map((candidate) => candidate.hit), overflowed: this.overflowed };
  }

  private trim(): void {
    this.candidates.sort(newerFirst);
    if (this.candidates.length > this.limit) {
      this.candidates.length = this.limit;
      this.overflowed = true;
    }
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The line around the match, at most MAX_HISTORY_LINE_LENGTH characters, and the match position inside it. */
function snippet(line: string, index: number, length: number): { line: string; offset: number } {
  if (line.length <= MAX_HISTORY_LINE_LENGTH) return { line, offset: index };
  const start = Math.min(
    Math.max(0, index - Math.floor((MAX_HISTORY_LINE_LENGTH - length) / 2)),
    line.length - MAX_HISTORY_LINE_LENGTH,
  );
  return { line: line.slice(start, start + MAX_HISTORY_LINE_LENGTH), offset: index - start };
}

/** Splits the stream of one session into lines and reports those containing the query. */
class LineScanner {
  private readonly decoder = new TextDecoder();
  private readonly stripper = new AnsiStripper();
  private line = "";
  /** Where the next character is written (0 to line.length). */
  private cursor = 0;
  private timestamp = 0;
  private lineTimestamp = 0;
  /** The open line has a hit already. */
  private reported = false;

  constructor(
    private readonly sessionId: SessionId,
    private readonly pattern: RegExp,
    private readonly queryLength: number,
    private readonly onHit: (hit: HistoryHit) => void,
  ) {}

  feed(entry: HistoryEntry): void {
    this.timestamp = entry.timestamp;
    this.apply(this.stripper.push(this.decoder.decode(entry.data, { stream: true })));
  }

  /** The last line of the history may still be open. */
  finish(): void {
    this.apply(this.stripper.push(this.decoder.decode()));
    this.endLine();
  }

  /**
   * Builds the lines like a terminal would show them, in one row with a cursor: text overwrites at the cursor
   * (or extends the line), backspace moves the cursor back (not before the start), carriage return moves it to
   * the start, ERASE_TO_EOL cuts the line at the cursor and a line feed ends the line.
   */
  private apply(text: string): void {
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      if (char >= " " || char === "\t") continue;
      this.write(text.slice(start, i));
      start = i + 1;
      if (char === "\n") this.endLine();
      else if (char === "\r") this.cursor = 0;
      else if (char === "\b") this.cursor = Math.max(0, this.cursor - 1);
      else if (char === ERASE_TO_EOL) this.line = this.line.slice(0, this.cursor);
    }
    this.write(text.slice(start));
  }

  private write(text: string): void {
    if (text.length === 0) return;
    // The time of a hit is when its line began, not when the line ended.
    if (this.line.length === 0) this.lineTimestamp = this.timestamp;
    const end = this.cursor + text.length;
    if (this.cursor === this.line.length) this.line += text;
    else
      this.line =
        this.line.slice(0, this.cursor) + text + (end < this.line.length ? this.line.slice(end) : "");
    this.cursor += text.length;
    while (this.line.length > MAX_SEARCH_LINE_BUFFER) {
      const head = this.line.slice(0, MAX_SEARCH_LINE_BUFFER);
      this.scan(head);
      // A match across the cut stays findable: the tail that is one character shorter than the query is kept.
      const keep = Math.min(this.queryLength - 1, MAX_SEARCH_LINE_BUFFER / 2);
      this.line = head.slice(head.length - keep) + this.line.slice(MAX_SEARCH_LINE_BUFFER);
      // The cursor keeps its place in the text that is left; one that was in the scanned part starts over.
      this.cursor = Math.max(0, this.cursor - (MAX_SEARCH_LINE_BUFFER - keep));
    }
  }

  private endLine(): void {
    if (this.line.length > 0) this.scan(this.line);
    this.line = "";
    this.cursor = 0;
    this.reported = false;
  }

  private scan(line: string): void {
    // One hit per line, also for a line that is scanned in several pieces.
    if (this.reported) return;
    const match = this.pattern.exec(line);
    if (!match) return;
    this.reported = true;
    this.onHit({
      sessionId: this.sessionId,
      timestamp: this.lineTimestamp,
      ...snippet(line, match.index, match[0].length),
    });
  }
}

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Searches the history of the sessions for `query` (plain text, case-insensitive). Returns the newest hits first,
 * at most `limit`, one per line. `truncated` is true when more hits existed than `limit` or the time limit ended
 * the search; the hits are then a partial result. A session deleted meanwhile contributes nothing.
 */
export async function searchHistory(
  source: HistorySearchSource,
  options: HistorySearchOptions,
): Promise<HistorySearchResult> {
  const { query, isKnownSession } = options;
  const limit = Math.min(MAX_HISTORY_HITS, Math.max(1, Math.floor(options.limit ?? MAX_HISTORY_HITS)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.maxMs ?? DEFAULT_SEARCH_MAX_MS);
  // A line break never occurs inside a line, so such a query finds nothing.
  if (query.length === 0 || /[\r\n]/.test(query)) return { hits: [], truncated: false };
  const pattern = new RegExp(escapeRegExp(query), "i");
  const collector = new HitCollector(limit);
  let timedOut = false;

  const wanted = options.sessionIds ?? (await source.listSessions());
  for (const sessionId of new Set(wanted)) {
    if (!SAFE_SESSION_ID.test(sessionId) || (isKnownSession && !isKnownSession(sessionId))) continue;
    if (now() >= deadline) {
      timedOut = true;
      break;
    }
    const scanner = new LineScanner(sessionId, pattern, query.length, (hit) => collector.add(hit));
    let finished = true;
    // `break` ends the generator, which gives the read lock back (HistoryStore.read).
    for await (const entry of source.read(sessionId)) {
      scanner.feed(entry);
      if (now() >= deadline) {
        timedOut = true;
        finished = false;
        break;
      }
    }
    if (finished) scanner.finish();
    if (timedOut) break;
  }
  const { hits, overflowed } = collector.result();
  return { hits, truncated: timedOut || overflowed };
}
