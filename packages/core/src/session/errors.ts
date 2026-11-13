import type { ErrorCode } from "@termdock/protocol";

/** Error with a stable code that the IPC server passes on unchanged (ADR 0002). */
export class CoreError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CoreError";
    this.code = code;
  }
}
