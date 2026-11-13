// Backend abstraction (ADR 0003). Shared building block: only the orchestrator or an explicitly briefed agent edits this file.
import type { BackendKind, LaunchSpec, SessionId, TerminalSize } from "@termdock/protocol";

export interface Disposable {
  dispose(): void;
}

/** The single PTY the Core holds for a running session. */
export interface PtyHandle {
  write(data: Uint8Array | string): void;
  resize(size: TerminalSize): void;
  onData(listener: (data: Uint8Array) => void): Disposable;
  /** Fires once when the PTY ends. `exitCode` is undefined when the backend cannot tell (e.g. tmux client lost). */
  onExit(listener: (event: { exitCode?: number }) => void): Disposable;
  /** Closes the PTY without ending the backend session (WSL: detaches from tmux; Windows: ends the shell). */
  dispose(): void;
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
  /** Creates the backend session and returns its PTY. */
  start(id: SessionId, spec: LaunchSpec, size: TerminalSize): Promise<PtyHandle>;
  /** Re-attaches to a backend session that survived the PTY (WSL/tmux). Rejects for backends without persistence. */
  attach(id: SessionId, spec: LaunchSpec, size: TerminalSize): Promise<PtyHandle>;
  /** Whether the backend session still exists, without attaching. */
  exists(id: SessionId, spec: LaunchSpec): Promise<boolean>;
  /** Ends the backend session and its processes. Resolves when it is gone. */
  kill(id: SessionId, spec: LaunchSpec): Promise<void>;
  /** Visible screen content for a new view; undefined when the backend keeps no screen (Core buffer is used). */
  snapshot(id: SessionId, spec: LaunchSpec): Promise<TerminalSnapshot | undefined>;
}
