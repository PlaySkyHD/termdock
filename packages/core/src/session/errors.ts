import type { ErrorCode, SessionId } from "@termdock/protocol";

/** Error with a stable code that the IPC server passes on unchanged (ADR 0002). */
export class CoreError extends Error {
  readonly code: ErrorCode;
  /** Session the error refers to, e.g. the new id when `create` registered a session whose start failed. */
  readonly sessionId: SessionId | undefined;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown; sessionId?: SessionId }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CoreError";
    this.code = code;
    this.sessionId = options?.sessionId;
  }
}
