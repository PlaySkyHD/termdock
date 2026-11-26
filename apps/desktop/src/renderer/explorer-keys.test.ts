// Issue #202 (openspec change explorer-panel): keyboard of the explorer tree.
import { describe, expect, it } from "vitest";
import type { FileEntry } from "../shared/files.js";
import { explorerClick, explorerDoubleClick, explorerKey } from "./explorer-keys.js";
import type { ExplorerRow } from "./explorer-tree.js";

const entry = (path: string, depth: number, folder: boolean, expanded = false): ExplorerRow => {
  const name = path.split("/").at(-1)!;
  const info: FileEntry = { name, kind: folder ? "directory" : "file", size: 0, modified: 0 };
  const parent = path.slice(0, path.lastIndexOf("/"));
  return { kind: "entry", path, name, parent, depth, entry: info, folder, expanded };
};

// src (open) / main.ts, docs (closed), a.txt
const ROWS: ExplorerRow[] = [
  entry("/r/src", 0, true, true),
  entry("/r/src/main.ts", 1, false),
  { kind: "truncated", path: "/r/src", depth: 1, shown: 1, total: 9 },
  entry("/r/docs", 0, true),
  entry("/r/a.txt", 0, false),
];

describe("explorerKey", () => {
  it("moves the selection up and down over entries only, and stops at the ends", () => {
    expect(explorerKey("ArrowDown", ROWS, undefined)).toEqual({ kind: "select", path: "/r/src" });
    expect(explorerKey("ArrowUp", ROWS, undefined)).toEqual({ kind: "select", path: "/r/a.txt" });
    expect(explorerKey("ArrowDown", ROWS, "/r/src/main.ts")).toEqual({ kind: "select", path: "/r/docs" });
    expect(explorerKey("ArrowUp", ROWS, "/r/docs")).toEqual({ kind: "select", path: "/r/src/main.ts" });
    expect(explorerKey("ArrowDown", ROWS, "/r/a.txt")).toBeUndefined();
    expect(explorerKey("ArrowUp", ROWS, "/r/src")).toBeUndefined();
    expect(explorerKey("Home", ROWS, "/r/a.txt")).toEqual({ kind: "select", path: "/r/src" });
    expect(explorerKey("End", ROWS, "/r/src")).toEqual({ kind: "select", path: "/r/a.txt" });
  });

  it("opens with right and goes into an open folder; left closes or goes to the parent", () => {
    expect(explorerKey("ArrowRight", ROWS, "/r/docs")).toEqual({ kind: "expand", path: "/r/docs" });
    expect(explorerKey("ArrowRight", ROWS, "/r/src")).toEqual({ kind: "select", path: "/r/src/main.ts" });
    expect(explorerKey("ArrowRight", ROWS, "/r/a.txt")).toBeUndefined();
    expect(explorerKey("ArrowLeft", ROWS, "/r/src")).toEqual({ kind: "collapse", path: "/r/src" });
    expect(explorerKey("ArrowLeft", ROWS, "/r/src/main.ts")).toEqual({ kind: "select", path: "/r/src" });
    expect(explorerKey("ArrowLeft", ROWS, "/r/a.txt")).toBeUndefined();
  });

  it("opens a file with Enter and opens or closes a folder", () => {
    expect(explorerKey("Enter", ROWS, "/r/a.txt")).toEqual({ kind: "open", path: "/r/a.txt" });
    expect(explorerKey("Enter", ROWS, "/r/docs")).toEqual({ kind: "expand", path: "/r/docs" });
    expect(explorerKey("Enter", ROWS, "/r/src")).toEqual({ kind: "collapse", path: "/r/src" });
    expect(explorerKey("Enter", ROWS, undefined)).toBeUndefined();
  });

  it("hands the keys back to the terminal with Escape, also without entries", () => {
    expect(explorerKey("Escape", ROWS, "/r/src")).toEqual({ kind: "leave" });
    expect(explorerKey("Escape", [], undefined)).toEqual({ kind: "leave" });
    expect(explorerKey("ArrowDown", [], undefined)).toBeUndefined();
    expect(explorerKey("a", ROWS, "/r/src")).toBeUndefined();
  });

  it("opens or closes a folder on a click and opens a file on a double click", () => {
    const [src, main, , docs] = ROWS as Array<Extract<ExplorerRow, { kind: "entry" }>>;
    expect(explorerClick(src!)).toEqual({ kind: "collapse", path: "/r/src" });
    expect(explorerClick(docs!)).toEqual({ kind: "expand", path: "/r/docs" });
    expect(explorerClick(main!)).toEqual({ kind: "select", path: "/r/src/main.ts" });
    expect(explorerDoubleClick(main!)).toEqual({ kind: "open", path: "/r/src/main.ts" });
    expect(explorerDoubleClick(docs!)).toBeUndefined();
  });

  // Issue #203 (openspec change explorer-actions): F2 renames, Delete asks to delete the selected entry.
  it("renames the selected entry with F2 and deletes it with Delete; nothing without a selection", () => {
    expect(explorerKey("F2", ROWS, "/r/a.txt")).toEqual({ kind: "rename", path: "/r/a.txt" });
    expect(explorerKey("Delete", ROWS, "/r/src")).toEqual({ kind: "delete", path: "/r/src" });
    expect(explorerKey("F2", ROWS, undefined)).toBeUndefined();
    expect(explorerKey("Delete", ROWS, "/r/gone")).toBeUndefined();
  });

  it("treats a selection that is no longer visible like none", () => {
    expect(explorerKey("ArrowDown", ROWS, "/r/gone")).toEqual({ kind: "select", path: "/r/src" });
  });
});
