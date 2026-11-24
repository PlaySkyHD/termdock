// Backend abstraction (ADR 0003). Shared building block: only the orchestrator or an explicitly briefed agent edits this file.
import type { BackendKind, LaunchSpec, SessionId, SessionWarning, TerminalSize } from "@termdock/protocol";

export interface Disposable {
  dispose(): void;
}

/** The single PTY the Core holds for a running session. */
export interface PtyHandle {
  write(data: Uint8Array | string): void;
  resize(size: TerminalSize): void;
  onData(listener: (data: Uint8Array) => void): Disposable;
  /**
   * Fires once when the PTY ends. `exitCode` is undefined when the backend cannot tell (e.g. tmux client lost);
   * the registry then asks `exists` and re-attaches if the backend session lives on. A backend without
   * persistence must report `exists` false once its PTY ended.
   */
  onExit(listener: (event: { exitCode?: number }) => void): Disposable;
  /** Closes the PTY without ending the backend session (WSL: detaches from tmux; Windows: ends the shell). */
  dispose(): void;
  /**
   * After `dispose`: resolves once the PTY's process has ended, or the wait for it gave up (WSL: ConPTYs end one
   * after the other, issue #160). Optional: without it a disposed PTY counts as closed at once.
   */
  closed?(): Promise<void>;
  /**
   * Problems `start` found that did not stop it (WSL: the working directory is missing, issue #113). Only on a PTY
   * from `start`; undefined or empty when there are none or the backend could not tell.
   */
  readonly warnings?: readonly SessionWarning[] | undefined;
}

/** Content a newly attached view shows before live output (ADR 0003). */
export interface TerminalSnapshot {
  data: Uint8Array;
  cursor?: { x: number; y: number };
}

export interface Backend {
  readonly kind: BackendKind;
  /** Whether the backend can be used at all (WSL installed and distro reachable, shell present). */
  available(): Promise<boolean>;
  /**
   * Fills in defaults the backend would otherwise pick on every call (WSL: the distro), so the stored spec
   * pins them. The registry calls it before a start and stores the result. Optional: without it the spec stays.
   */
  resolveLaunch?(spec: LaunchSpec): Promise<LaunchSpec>;
  /** Creates the backend session and returns its PTY. */
  start(id: SessionId, spec: LaunchSpec, size: TerminalSize): Promise<PtyHandle>;
  /** Re-attaches to a backend session that survived the PTY (WSL/tmux). Rejects for backends without persistence. */
  attach(id: SessionId, spec: LaunchSpec, size: TerminalSize): Promise<PtyHandle>;
  /** Whether the backend session still exists, without attaching. */
  exists(id: SessionId, spec: LaunchSpec): Promise<boolean>;
  /**
   * Which of `sessions` still exist, judged like `exists`, with one backend call per group instead of one per
   * session (WSL: one `tmux list-sessions` per distro, issue #134). The reconcile uses it for many sessions at once;
   * `exists` stays for single checks. Undefined when the backend cannot tell (a call failed): the caller then asks
   * `exists` per session. Optional: without it the caller asks `exists` per session.
   */
  listLive?(
    sessions: readonly { id: SessionId; spec: LaunchSpec }[],
  ): Promise<ReadonlySet<SessionId> | undefined>;
  /** Ends the backend session and its processes. Resolves when it is gone. */
  kill(id: SessionId, spec: LaunchSpec): Promise<void>;
  /** Visible screen content for a new view; undefined when the backend keeps no screen (Core buffer is used). */
  snapshot(id: SessionId, spec: LaunchSpec): Promise<TerminalSnapshot | undefined>;
  /**
   * Makes the backend paint the whole screen into the PTY again (WSL: `tmux refresh-client`). The registry calls
   * it after a view attached with a `snapshot`: the PTY lags behind that screen, and the repaint overwrites
   * output the view got twice or missed (issue #34). Optional: backends without `snapshot` need none.
   */
  redraw?(id: SessionId, spec: LaunchSpec): Promise<void>;
}
