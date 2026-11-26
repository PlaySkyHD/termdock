// Throttled queries of one session's current directory (issue #199, design of openspec change session-current-cwd).
// Free of the registry and the backend: query, result, clock come from outside, so the timing is testable.

/** Quiet time after the last output before the directory is asked: a `cd` ends with its prompt. */
export const CWD_QUIET_MS = 300;
/** Least time between the start of two queries of a session (each is a `wsl.exe` process). */
export const CWD_MIN_INTERVAL_MS = 1_000;
/**
 * Longest time between two queries the back-off reaches: an answer that changed nothing doubles the interval up to
 * this, so a TUI or a progress bar in a viewed session costs one `wsl.exe` every 8 s instead of every second.
 */
export const CWD_MAX_INTERVAL_MS = 8_000;

/** A directory, `null` for "the session has none to show" (removed), undefined for "cannot tell". */
export type CwdAnswer = string | null | undefined;

export interface CwdProbeOptions {
  /** Asks the backend; undefined or a rejection means "cannot tell" and is dropped. */
  query: () => Promise<CwdAnswer>;
  /** Called with every answer of the current binding; the caller decides whether it is a change. */
  onResult: (cwd: string | null) => void;
  quietMs?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  /** Monotonic clock in ms; defaults to `performance.now()`. */
  now?: () => number;
}

/**
 * One session's directory queries, for the session's whole life (across PTY changes): at most one at a time, and
 * between their starts at least the current interval. The interval starts at `minIntervalMs` and doubles with every
 * answer that brought nothing new, up to `maxIntervalMs`; a new answer, `input` (Enter was typed, maybe a `cd`) and
 * `poke` set it back. Output (`activity`) asks once it has paused for `quietMs`; `poke` asks as soon as the interval
 * allows (a view attached), and later output does not put it off. Output during a query plans exactly one more after
 * it. `idle` drops what is planned (no view left). `unbind` (the PTY ended or was replaced) also drops the answer of
 * a running query, but the query still counts: no second one starts before it ends. `dispose` ends the probe.
 */
export class CwdProbe {
  private readonly query: () => Promise<CwdAnswer>;
  private readonly onResult: (cwd: string | null) => void;
  private readonly quietMs: number;
  private readonly minIntervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The planned query comes from `poke`. */
  private urgent = false;
  private running = false;
  /** Asked for while a query ran; one follow-up after it. */
  private again = false;
  private lastStart = Number.NEGATIVE_INFINITY;
  private interval: number;
  /** The last answer the backend gave, for the back-off. */
  private lastAnswer: string | null | undefined;
  /** Raised by `unbind`; a query started under an older one has its answer dropped. */
  private generation = 0;
  private disposed = false;

  constructor(options: CwdProbeOptions) {
    this.query = options.query;
    this.onResult = options.onResult;
    this.quietMs = options.quietMs ?? CWD_QUIET_MS;
    this.minIntervalMs = options.minIntervalMs ?? CWD_MIN_INTERVAL_MS;
    this.maxIntervalMs = Math.max(this.minIntervalMs, options.maxIntervalMs ?? CWD_MAX_INTERVAL_MS);
    this.interval = this.minIntervalMs;
    this.now = options.now ?? (() => performance.now());
  }

  /** The session printed something: ask once it has been quiet for `quietMs`. */
  activity(): void {
    this.schedule(this.quietMs, false);
  }

  /** Enter was typed into the session: the next query may come after `minIntervalMs` again. */
  input(): void {
    this.interval = this.minIntervalMs;
  }

  /** Ask as soon as `minIntervalMs` allows; later output does not put it off. */
  poke(): void {
    this.interval = this.minIntervalMs;
    this.schedule(0, true);
  }

  /** No view left: drop the planned query and the follow-up; a running one still delivers. */
  idle(): void {
    this.clearTimer();
    this.again = false;
  }

  /** The PTY ended or is replaced: nothing planned stays, and the answer of a running query is dropped. */
  unbind(): void {
    this.idle();
    this.generation += 1;
    this.lastAnswer = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.unbind();
  }

  private schedule(delayMs: number, urgent: boolean): void {
    if (this.disposed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    // A planned `poke` stays: steady output would otherwise keep a newly attached view from ever being answered.
    if (this.timer !== undefined && this.urgent) return;
    this.clearTimer();
    this.urgent = urgent;
    const wait = Math.max(delayMs, this.lastStart + this.interval - this.now());
    this.timer = setTimeout(() => this.run(), wait);
  }

  private run(): void {
    this.timer = undefined;
    this.running = true;
    this.lastStart = this.now();
    const generation = this.generation;
    const current = (): boolean => !this.disposed && generation === this.generation;
    void this.query()
      .then(
        (cwd) => {
          if (!current()) return;
          this.backOff(cwd);
          if (cwd !== undefined) this.onResult(cwd);
        },
        () => {
          if (current()) this.backOff(undefined);
        },
      )
      .finally(() => {
        this.running = false;
        if (!this.again) return;
        this.again = false;
        this.schedule(this.quietMs, false);
      });
  }

  private backOff(cwd: CwdAnswer): void {
    if (cwd !== undefined && cwd !== this.lastAnswer) {
      this.lastAnswer = cwd;
      this.interval = this.minIntervalMs;
    } else {
      this.interval = Math.min(this.interval * 2, this.maxIntervalMs);
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.urgent = false;
  }
}
