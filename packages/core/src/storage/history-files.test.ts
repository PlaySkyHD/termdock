import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeSessionHistory, sessionHistoryDir } from "./history-files.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "termdock-history-"));
  tempDirs.push(dir);
  return dir;
}

const ID = "11111111-1111-4111-8111-111111111111";

describe("history files (ADR 0004, issue #57)", () => {
  it("places the history of a session under history/<sessionId>", () => {
    const root = dataDir();
    expect(sessionHistoryDir(root, ID)).toBe(join(root, "history", ID));
  });

  it("removes the directory with its segments and leaves other sessions alone", async () => {
    const root = dataDir();
    const own = sessionHistoryDir(root, ID);
    const other = sessionHistoryDir(root, "other-session");
    for (const dir of [own, other]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "a.log"), "output");
      writeFileSync(join(dir, "b.log"), "output");
    }

    await removeSessionHistory(root, ID);

    expect(existsSync(own)).toBe(false);
    expect(existsSync(join(other, "a.log"))).toBe(true);
  });

  it("is idempotent when no history exists", async () => {
    const root = dataDir();
    await removeSessionHistory(root, ID);
    await removeSessionHistory(root, ID);
    expect(existsSync(join(root, "history"))).toBe(false);
  });

  it.each(["", ".", "..", "../x", "a/b", "a\\b", "C:", "x\u0000"])(
    "rejects the id %j instead of building a path outside history/",
    async (id) => {
      const root = dataDir();
      const victim = join(root, "termdock.db");
      writeFileSync(victim, "db");

      expect(() => sessionHistoryDir(root, id)).toThrow();
      await expect(removeSessionHistory(root, id)).rejects.toThrow();
      expect(existsSync(victim)).toBe(true);
    },
  );
});
