// Named pipe path of the core (ADR 0001, ADR 0002): one pipe per Windows account.
import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";

/** Keeps letters, digits, `_`, `.` and `-`; everything else (backslash, space, ...) becomes `_`. */
export function sanitizePipeUser(user: string): string {
  const cleaned = user.replace(/[^A-Za-z0-9_.-]/g, "_");
  return cleaned.length > 0 ? cleaned : "user";
}

/**
 * `\\.\pipe\termdock-core-<cleaned user>-<12 hex of sha256(domain\user)>`. The cleaned part is only for
 * reading; the hash over the raw domain and user keeps accounts apart whose names clean to the same text
 * (Jörg/Jürg) or that differ only by domain (DOMAIN\bob, PC\bob).
 */
export function defaultPipeName(
  user: string = userInfo().username,
  domain: string = process.env["USERDOMAIN"] ?? hostname(),
): string {
  const hash = createHash("sha256").update(`${domain}\\${user}`).digest("hex").slice(0, 12);
  return `\\\\.\\pipe\\termdock-core-${sanitizePipeUser(user)}-${hash}`;
}
