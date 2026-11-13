import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAYOUT_VERSION } from "@termdock/protocol";
import type { LayoutDocument } from "@termdock/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CoreError } from "../session/errors.js";
import { DATABASE_FILE, openStorage } from "./database.js";
import type { Storage } from "./database.js";
import { InMemoryLayoutRepository } from "./layout-repository.js";
import type { LayoutRepository } from "./layout-repository.js";

const opened: Storage[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const storage of opened.splice(0)) storage.dispose();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function open(dir: string): Storage {
  const storage = openStorage({ dataDir: dir });
  opened.push(storage);
  return storage;
}

function sqlite(): LayoutRepository {
  const dir = mkdtempSync(join(tmpdir(), "termdock-layout-"));
  tempDirs.push(dir);
  return open(dir).layouts;
}

function layout(title: string): LayoutDocument {
  return {
    version: LAYOUT_VERSION,
    windows: [
      {
        id: "w1",
        bounds: { x: 10, y: 20, width: 900, height: 600 },
        sidebarVisible: true,
        tabs: [
          {
            id: "t1",
            title,
            root: {
              kind: "split",
              id: "s1",
              direction: "row",
              children: [
                { kind: "pane", id: "p1", sessionId: "session-1" },
                { kind: "pane", id: "p2", sessionId: "missing" },
              ],
              sizes: [0.4, 0.6],
            },
            activePaneId: "p2",
          },
        ],
        activeTabId: "t1",
      },
    ],
  };
}

function conflict(repository: LayoutRepository, doc: LayoutDocument, baseRevision: number): unknown {
  try {
    repository.save(doc, baseRevision);
  } catch (error) {
    return error;
  }
  throw new Error("expected a revision conflict");
}

const implementations: [string, () => LayoutRepository][] = [
  ["InMemoryLayoutRepository", () => new InMemoryLayoutRepository()],
  ["SqliteLayoutRepository", sqlite],
];

describe.each(implementations)("%s", (_name, create) => {
  it("starts empty at revision 0", () => {
    expect(create().get()).toEqual({ revision: 0 });
  });

  it("returns what was saved and counts revisions", () => {
    const repository = create();
    expect(repository.save(layout("one"))).toBe(1);
    expect(repository.get()).toEqual({ layout: layout("one"), revision: 1 });
    expect(repository.save(layout("two"))).toBe(2);
    expect(repository.get()).toEqual({ layout: layout("two"), revision: 2 });
  });

  it("saves with a matching baseRevision and rejects a stale one with invalid_state", () => {
    const repository = create();
    expect(repository.save(layout("one"), 0)).toBe(1);
    expect(repository.save(layout("two"), 1)).toBe(2);
    const error = conflict(repository, layout("three"), 1);
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe("invalid_state");
    expect(repository.get()).toEqual({ layout: layout("two"), revision: 2 });
    expect((conflict(repository, layout("three"), 5) as CoreError).code).toBe("invalid_state");
  });

  it("does not share state with the saved or returned object", () => {
    const repository = create();
    const doc = layout("one");
    repository.save(doc);
    doc.windows[0]!.id = "changed";
    const first = repository.get().layout!;
    first.windows[0]!.id = "changed too";
    expect(repository.get().layout).toEqual(layout("one"));
  });
});

describe("SqliteLayoutRepository with a stored document that cannot be used", () => {
  const broken: [string, string][] = [
    ["not JSON", "{not json"],
    ["an old version", JSON.stringify({ ...layout("one"), version: 0 })],
    ["unknown keys", JSON.stringify({ ...layout("one"), legacy: true })],
  ];

  it.each(broken)(
    "reports %s and offers no layout, but keeps the revision for the next save",
    (_name, data) => {
      const dir = mkdtempSync(join(tmpdir(), "termdock-layout-"));
      tempDirs.push(dir);
      const messages: string[] = [];
      const storage = openStorage({ dataDir: dir, onLayoutInvalid: (message) => messages.push(message) });
      opened.push(storage);
      storage.layouts.save(layout("one"));
      storage.layouts.save(layout("two"));
      const other = new DatabaseSync(join(dir, DATABASE_FILE));
      try {
        other.prepare("UPDATE layouts SET data = ?").run(data);
      } finally {
        other.close();
      }

      expect(storage.layouts.get()).toEqual({ revision: 2 });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("stored layout");
      expect(storage.layouts.save(layout("three"), 2)).toBe(3);
      expect(storage.layouts.get()).toEqual({ layout: layout("three"), revision: 3 });
    },
  );
});

describe("SqliteLayoutRepository", () => {
  it("leaves no open transaction after a conflict and reports the conflict, not a rollback error", () => {
    const dir = mkdtempSync(join(tmpdir(), "termdock-layout-"));
    tempDirs.push(dir);
    const storage = open(dir);
    storage.layouts.save(layout("one"));
    expect((conflict(storage.layouts, layout("two"), 7) as CoreError).code).toBe("invalid_state");
    expect(storage.layouts.save(layout("two"), 1)).toBe(2);
  });

  it("keeps layout and revision across a reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "termdock-layout-"));
    tempDirs.push(dir);
    const first = open(dir);
    first.layouts.save(layout("one"));
    first.layouts.save(layout("two"));
    first.dispose();
    expect(open(dir).layouts.get()).toEqual({ layout: layout("two"), revision: 2 });
  });
});
