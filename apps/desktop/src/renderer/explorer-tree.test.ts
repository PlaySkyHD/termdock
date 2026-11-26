// Issue #202 (openspec change explorer-panel): the tree model of the explorer panel.
import { describe, expect, it } from "vitest";
import type { FileEntry, FileListResult, FileLocation } from "../shared/files.js";
import {
  childPath,
  collapse,
  entryRow,
  expand,
  finishLoad,
  loadRoot,
  refreshAll,
  reloadFolder,
  replaceEntry,
  rowsOf,
  selectEntry,
  treeFor,
} from "./explorer-tree.js";
import type { ExplorerTree, ListRequest } from "./explorer-tree.js";

const ROOT: FileLocation = { backend: "wsl", distro: "Ubuntu", path: "/tmp/shot" };
const dir = (name: string): FileEntry => ({ name, kind: "directory", size: 0, modified: 1 });
const file = (name: string, size = 3): FileEntry => ({ name, kind: "file", size, modified: 1 });
const listed = (...entries: FileEntry[]): FileListResult => ({
  ok: true,
  entries,
  truncated: false,
  total: entries.length,
});

/** The tree for ROOT with its listing answered. */
function loaded(result: FileListResult = listed(dir("src"), file("a.txt"))): ExplorerTree {
  const { tree, request } = loadRoot(treeFor(ROOT));
  return finishLoad(tree, request, result);
}

function opened(tree: ExplorerTree, path: string, result: FileListResult): ExplorerTree {
  const { tree: next, request } = expand(tree, path);
  return finishLoad(next, request!, result);
}

const names = (tree: ExplorerTree): string[] =>
  rowsOf(tree).map((row) =>
    row.kind === "entry" ? `${"  ".repeat(row.depth)}${row.name}` : `<${row.kind}>`,
  );

describe("explorer tree", () => {
  it("lists the root in the order of the service, folders marked", () => {
    const tree = loaded();
    expect(names(tree)).toEqual(["src", "a.txt"]);
    expect(rowsOf(tree).map((row) => row.kind === "entry" && row.folder)).toEqual([true, false]);
    expect(entryRow(rowsOf(tree), "/tmp/shot/src")?.expanded).toBe(false);
  });

  it("asks for the root at the root's location", () => {
    const { request } = loadRoot(treeFor(ROOT));
    expect(request.location).toEqual(ROOT);
  });

  it("loads a folder when it opens and shows a loading row until the answer", () => {
    const { tree, request } = expand(loaded(), "/tmp/shot/src");
    expect(request?.location).toEqual({ ...ROOT, path: "/tmp/shot/src" });
    expect(names(tree)).toEqual(["src", "<loading>", "a.txt"]);

    const done = finishLoad(tree, request!, listed(file("main.ts")));
    expect(names(done)).toEqual(["src", "  main.ts", "a.txt"]);
  });

  it("shows an empty folder, an error and a truncated listing as rows", () => {
    const empty = opened(loaded(), "/tmp/shot/src", listed());
    expect(names(empty)).toEqual(["src", "<empty>", "a.txt"]);

    const failed = opened(loaded(), "/tmp/shot/src", { ok: false, code: "EACCES" });
    expect(rowsOf(failed)[1]).toEqual({ kind: "error", path: "/tmp/shot/src", depth: 1, code: "EACCES" });

    const cut = loaded({ ok: true, entries: [file("a")], truncated: true, total: 5003 });
    expect(rowsOf(cut).at(-1)).toEqual({
      kind: "truncated",
      path: "/tmp/shot",
      depth: 0,
      shown: 1,
      total: 5003,
    });
  });

  it("keeps a listed folder when it closes and opens again, without a new load", () => {
    const tree = opened(loaded(), "/tmp/shot/src", listed(file("main.ts")));
    const closed = collapse(tree, "/tmp/shot/src");
    expect(names(closed)).toEqual(["src", "a.txt"]);

    const again = expand(closed, "/tmp/shot/src");
    expect(again.request).toBeUndefined();
    expect(names(again.tree)).toEqual(["src", "  main.ts", "a.txt"]);
  });

  it("lists a folder again whose listing failed", () => {
    const failed = collapse(opened(loaded(), "/tmp/shot/src", { ok: false, code: "OTHER" }), "/tmp/shot/src");
    expect(expand(failed, "/tmp/shot/src").request).toBeDefined();
  });

  it("drops an answer that is older than the latest load of the same folder", () => {
    const first = loadRoot(treeFor(ROOT));
    const second = loadRoot(first.tree);
    const fresh = finishLoad(second.tree, second.request, listed(file("new")));
    // The slow first answer arrives last.
    expect(finishLoad(fresh, first.request, listed(file("old")))).toBe(fresh);
    expect(names(fresh)).toEqual(["new"]);
  });

  it("drops an answer for the folder of a tree it no longer shows", () => {
    const old = loadRoot(treeFor(ROOT));
    // The session changed its directory, and back: a new tree each time, the count of tokens goes on.
    const other = loadRoot(treeFor({ ...ROOT, path: "/srv" }, old.tree));
    const back = loadRoot(treeFor(ROOT, other.tree));
    expect(finishLoad(back.tree, old.request, listed(file("stale")))).toBe(back.tree);
    expect(finishLoad(other.tree, old.request, listed(file("stale")))).toBe(other.tree);
  });

  it("starts empty for a new folder: open folders and the selection are gone", () => {
    const tree = selectEntry(opened(loaded(), "/tmp/shot/src", listed(file("x"))), "/tmp/shot/src/x");
    const next = treeFor({ ...ROOT, path: "/tmp/shot/src" }, tree);
    expect(next.expanded.size).toBe(0);
    expect(next.folders.size).toBe(0);
    expect(next.selected).toBeUndefined();
  });

  it("refreshes the root and the visible open folders, showing the old entries meanwhile", () => {
    const tree = opened(loaded(), "/tmp/shot/src", listed(file("main.ts")));
    const { tree: refreshing, requests } = refreshAll(tree);
    expect(requests.map((request: ListRequest) => request.location.path)).toEqual([
      "/tmp/shot",
      "/tmp/shot/src",
    ]);
    expect(names(refreshing)).toEqual(["src", "  main.ts", "a.txt"]);

    let next = finishLoad(refreshing, requests[0]!, listed(dir("src"), file("b.txt")));
    next = finishLoad(next, requests[1]!, listed());
    expect(names(next)).toEqual(["src", "<empty>", "b.txt"]);
  });

  it("joins paths with the separator of the backend", () => {
    expect(childPath("wsl", "/", "tmp")).toBe("/tmp");
    expect(childPath("wsl", "/tmp", "a")).toBe("/tmp/a");
    expect(childPath("windows", "C:\\", "Temp")).toBe("C:\\Temp");
    expect(childPath("windows", "C:\\Temp", "a")).toBe("C:\\Temp\\a");
    const windows = loadRoot(treeFor({ backend: "windows", path: "C:\\Temp" }));
    const tree = finishLoad(windows.tree, windows.request, listed(dir("x")));
    expect(expand(tree, "C:\\Temp\\x").request?.location).toEqual({
      backend: "windows",
      path: "C:\\Temp\\x",
    });
  });

  it("opens a symlink to a folder like a folder", () => {
    const link: FileEntry = { name: "l", kind: "symlink", size: 0, modified: 0, targetKind: "directory" };
    const broken: FileEntry = { name: "m", kind: "symlink", size: 0, modified: 0 };
    const rows = rowsOf(loaded(listed(link, broken)));
    expect(rows.map((row) => row.kind === "entry" && row.folder)).toEqual([true, false]);
  });

  describe("for the file actions of #203", () => {
    it("replaces an entry in place and removes one, closing what was below it", () => {
      let tree = opened(loaded(), "/tmp/shot/src", listed(file("main.ts")));
      tree = selectEntry(tree, "/tmp/shot/src/main.ts");

      const resized = replaceEntry(tree, "/tmp/shot", "a.txt", file("a.txt", 9));
      expect(entryRow(rowsOf(resized), "/tmp/shot/a.txt")?.entry.size).toBe(9);
      expect(resized.selected).toBe("/tmp/shot/src/main.ts");

      const renamed = replaceEntry(tree, "/tmp/shot", "src", dir("lib"));
      expect(names(renamed)).toEqual(["lib", "a.txt"]);
      expect(renamed.expanded.has("/tmp/shot/src")).toBe(false);
      expect(renamed.selected).toBeUndefined();

      const removed = replaceEntry(tree, "/tmp/shot", "a.txt");
      expect(names(removed)).toEqual(["src", "  main.ts"]);
    });

    it("reloads one listed folder and leaves an unknown one alone", () => {
      const tree = loaded();
      expect(reloadFolder(tree, "/tmp/shot").request?.location.path).toBe("/tmp/shot");
      expect(reloadFolder(tree, "/tmp/shot/src")).toEqual({ tree });
    });
  });
});
