// Location of the persistent history on disk (ADR 0004): `<dataDir>/history/<sessionId>/` with the segments
// `a.log` and `b.log`. Deleting a session removes this directory (security.instructions.md, issue #57).
import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { SessionId } from "@termdock/protocol";

export const HISTORY_DIR = "history";

/** Session ids are UUIDs; stored ones are checked again, so no id can name a path outside `history/`. */
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** Directory of the history of one session. Throws for an id that is not a plain name. */
export function sessionHistoryDir(dataDir: string, sessionId: SessionId): string {
  if (!SESSION_ID.test(sessionId)) throw new Error(`Invalid session id for a history path: ${sessionId}`);
  const root = resolve(dataDir, HISTORY_DIR);
  const dir = resolve(root, sessionId);
  const inside = relative(root, dir);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`History path of ${sessionId} lies outside ${root}`);
  }
  return dir;
}

/**
 * Removes the history directory of a session recursively. Idempotent: a missing directory is fine. A link in
 * its place is removed itself, its target stays (`rm` does not follow links).
 */
export async function removeSessionHistory(dataDir: string, sessionId: SessionId): Promise<void> {
  await rm(sessionHistoryDir(dataDir, sessionId), { recursive: true, force: true, maxRetries: 3 });
}
