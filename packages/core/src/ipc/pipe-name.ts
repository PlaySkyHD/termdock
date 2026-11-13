// Named pipe path of the core (ADR 0001, ADR 0002): one pipe per Windows user.
import { userInfo } from "node:os";

/** Keeps letters, digits, `_`, `.` and `-`; everything else (backslash, space, ...) becomes `_`. */
export function sanitizePipeUser(user: string): string {
  const cleaned = user.replace(/[^A-Za-z0-9_.-]/g, "_");
  return cleaned.length > 0 ? cleaned : "user";
}

export function defaultPipeName(user: string = userInfo().username): string {
  return `\\\\.\\pipe\\termdock-core-${sanitizePipeUser(user)}`;
}
