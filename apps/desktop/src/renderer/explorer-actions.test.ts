// Issue #203 (openspec change explorer-actions): the rules of the file actions in the explorer panel.
import { describe, expect, it } from "vitest";
import type { FileEntry, FileListResult, FileLocation } from "../shared/files.js";
import {
  actionErrorText,
  afterDelete,
  afterFailure,
  afterMove,
  afterRename,
  canDropEntry,
  countsEntries,
  deleteConfirmation,
  deletePromptOpens,
  deleteRuns,
  dropTargetPath,
  explorerDropTarget,
  explorerMenu,
  isDropFolder,
  isProtectedPath,
  keepsRename,
  menuPath,
  menuPoint,
  offers,
  renameSelection,
  renameTarget,
  skippedText,
} from "./explorer-actions.js";
import type { DeleteRequest, MenuContext } from "./explorer-actions.js";
import { entryRow, expand, finishLoad, loadRoot, rowsOf, treeFor } from "./explorer-tree.js";
import type { ExplorerRow, ExplorerTree, ListRequest } from "./explorer-tree.js";

type EntryRow = Extract<ExplorerRow, { kind: "entry" }>;

const ROOT: FileLocation = { backend: "wsl", distro: "Ubuntu", path: "/tmp/p" };
const WIN_ROOT: FileLocation = { backend: "windows", path: "C:\\Users\\Public" };
const dir = (name: string): FileEntry => ({ name, kind: "directory", size: 0, modified: 1 });
const file = (name: string): FileEntry => ({ name, kind: "file", size: 3, modified: 1 });
const listed = (...entries: FileEntry[]): FileListResult => ({
  ok: true,
  entries,
  truncated: false,
  total: entries.length,
});

function loaded(root: FileLocation, ...entries: FileEntry[]): ExplorerTree {
  const { tree, request } = loadRoot(treeFor(root));
  return finishLoad(tree, request, listed(...entries));
}
function opened(tree: ExplorerTree, path: string, ...entries: FileEntry[]): ExplorerTree {
  const { tree: next, request } = expand(tree, path);
  return finishLoad(next, request!, listed(...entries));
}
const row = (tree: ExplorerTree, path: string): EntryRow => entryRow(rowsOf(tree), path)!;
const keys = (tree: ExplorerTree, path: string, context: MenuContext = WRITER): string[] =>
  explorerMenu(row(tree, path), locationOf(tree, path), context).map((entry) => entry.key);
const locationOf = (tree: ExplorerTree, path: string): FileLocation =>
  tree.root.backend === "wsl" ? { ...tree.root, path } : { backend: "windows", path };
const paths = (requests: readonly ListRequest[]): string[] =>
  requests.map((request) => request.location.path);

const WRITER: MenuContext = { writer: true, shell: "posix" };

describe("isProtectedPath", () => {
  it("protects the roots, everything directly under / and /mnt and under /mnt/wsl, like the main process", () => {
    const wsl = (path: string): FileLocation => ({ backend: "wsl", distro: "Ubuntu", path });
    for (const path of ["/", "/home", "/usr", "/mnt", "/mnt/c", "/mnt/wsl", "/mnt/wsl/x", "/home/"])
      expect(isProtectedPath(wsl(path)), path).toBe(true);
    for (const path of ["/tmp/p", "/home/dev", "/mnt/c/Users", "/mnt/wsl/x/y"])
      expect(isProtectedPath(wsl(path)), path).toBe(false);
  });

  it("protects a drive on Windows and nothing below it", () => {
    expect(isProtectedPath({ backend: "windows", path: "C:\\" })).toBe(true);
    expect(isProtectedPath({ backend: "windows", path: "d:" })).toBe(true);
    expect(isProtectedPath({ backend: "windows", path: "C:\\Windows" })).toBe(false);
  });
});

describe("explorerMenu", () => {
  const tree = opened(loaded(ROOT, dir("src"), file("a.txt")), "/tmp/p/src", file("main.ts"));

  it("offers for a WSL folder download, reveal, copy, paste, rename and delete, but no open", () => {
    expect(keys(tree, "/tmp/p/src")).toEqual([
      "download",
      "reveal",
      "copyPath",
      "pastePath",
      "rename",
      "delete",
    ]);
  });

  it("offers open for a file, also below the root", () => {
    expect(keys(tree, "/tmp/p/src/main.ts")[0]).toBe("open");
    expect(keys(tree, "/tmp/p/a.txt")).toContain("download");
  });

  it("offers no download on Windows", () => {
    const windows = loaded(WIN_ROOT, file("a.txt"));
    expect(keys(windows, "C:\\Users\\Public\\a.txt", { writer: true, shell: "cmd" })).toEqual([
      "open",
      "reveal",
      "copyPath",
      "pastePath",
      "rename",
      "delete",
    ]);
  });

  it("leaves out rename and delete on a protected location", () => {
    const top = loaded({ backend: "wsl", distro: "Ubuntu", path: "/" }, dir("home"));
    expect(keys(top, "/home")).toEqual(["download", "reveal", "copyPath", "pastePath"]);
  });

  it("disables paste without a writer and for a path with a control character, with the reason", () => {
    const reader = explorerMenu(row(tree, "/tmp/p/a.txt"), locationOf(tree, "/tmp/p/a.txt"), {
      writer: false,
      shell: "posix",
    });
    const paste = reader.find((entry) => entry.key === "pastePath")!;
    expect(paste.disabled).toBe(true);
    expect(paste.hint).toMatch(/schreibend/);
    expect(offers(reader, "pastePath")).toBe(false);
    expect(offers(reader, "rename")).toBe(true);

    const odd = loaded(ROOT, file("a\nb"));
    const entries = explorerMenu(row(odd, "/tmp/p/a\nb"), locationOf(odd, "/tmp/p/a\nb"), WRITER);
    expect(entries.find((entry) => entry.key === "pastePath")).toMatchObject({ disabled: true });
    expect(offers(entries, "copyPath")).toBe(true);
  });

  it("disables paste for a path with % in cmd, not in PowerShell", () => {
    const windows = loaded(WIN_ROOT, file("100%.txt"));
    const path = "C:\\Users\\Public\\100%.txt";
    const cmd = explorerMenu(row(windows, path), locationOf(windows, path), { writer: true, shell: "cmd" });
    expect(cmd.find((entry) => entry.key === "pastePath")).toMatchObject({ disabled: true });
    const pwsh = explorerMenu(row(windows, path), locationOf(windows, path), { writer: true, shell: "pwsh" });
    expect(offers(pwsh, "pastePath")).toBe(true);
  });

  it("marks delete as dangerous and separates the groups", () => {
    const entries = explorerMenu(row(tree, "/tmp/p/a.txt"), locationOf(tree, "/tmp/p/a.txt"), WRITER);
    expect(entries.find((entry) => entry.key === "delete")).toMatchObject({ danger: true });
    expect(entries.filter((entry) => entry.separator).map((entry) => entry.key)).toEqual([
      "copyPath",
      "rename",
    ]);
  });
});

describe("menuPath and menuPoint", () => {
  it("takes the row under the pointer, else the selected one", () => {
    expect(menuPath("/tmp/p/a.txt", "/tmp/p/src")).toBe("/tmp/p/a.txt");
    expect(menuPath(undefined, "/tmp/p/src")).toBe("/tmp/p/src");
    expect(menuPath(undefined, undefined)).toBeUndefined();
  });

  it("opens at the pointer, and below the row for the menu key and Shift+F10 (no pointer position)", () => {
    const box = { left: 100, bottom: 50 };
    expect(menuPoint({ x: 300, y: 40 }, box)).toEqual({ x: 300, y: 40 });
    expect(menuPoint({ x: 0, y: 0 }, box)).toEqual({ x: 124, y: 50 });
    expect(menuPoint({ x: 0, y: 0 }, undefined)).toEqual({ x: 0, y: 0 });
  });
});

describe("canDropEntry", () => {
  const tree = opened(
    opened(loaded(ROOT, dir("docs"), dir("src"), file("a.txt")), "/tmp/p/src", dir("lib"), file("main.ts")),
    "/tmp/p/src/lib",
  );
  const view = { root: tree.root, rows: rowsOf(tree) };

  it("takes a folder row or the root", () => {
    expect(canDropEntry(view, "/tmp/p/a.txt", "/tmp/p/docs")).toBe(true);
    expect(canDropEntry(view, "/tmp/p/src/main.ts", "/tmp/p")).toBe(true);
    expect(canDropEntry(view, "/tmp/p/src/lib", "/tmp/p/docs")).toBe(true);
  });

  it("never into the entry itself, a folder below it or the folder it is in", () => {
    expect(canDropEntry(view, "/tmp/p/src", "/tmp/p/src")).toBe(false);
    expect(canDropEntry(view, "/tmp/p/src", "/tmp/p/src/lib")).toBe(false);
    expect(canDropEntry(view, "/tmp/p/a.txt", "/tmp/p")).toBe(false);
    expect(canDropEntry(view, "/tmp/p/src/main.ts", "/tmp/p/src")).toBe(false);
  });

  it("not onto a file, an unknown target, or with a source that is not shown or protected", () => {
    expect(canDropEntry(view, "/tmp/p/docs", "/tmp/p/a.txt")).toBe(false);
    expect(canDropEntry(view, "/tmp/p/docs", "/tmp/elsewhere")).toBe(false);
    expect(canDropEntry(view, "/tmp/gone", "/tmp/p/docs")).toBe(false);
    const top = loaded({ backend: "wsl", distro: "Ubuntu", path: "/" }, dir("home"), dir("tmp"));
    expect(canDropEntry({ root: top.root, rows: rowsOf(top) }, "/home", "/tmp")).toBe(false);
  });

  it("takes no symlink to a folder as a target: it could point at the source or below it", () => {
    const link: FileEntry = { name: "link", kind: "symlink", size: 0, modified: 1, targetKind: "directory" };
    const linked = loaded(ROOT, dir("docs"), link, file("a.txt"));
    const linkedView = { root: linked.root, rows: rowsOf(linked) };
    expect(row(linked, "/tmp/p/link").folder).toBe(true);
    expect(isDropFolder(row(linked, "/tmp/p/link"))).toBe(false);
    expect(isDropFolder(row(linked, "/tmp/p/docs"))).toBe(true);
    expect(canDropEntry(linkedView, "/tmp/p/docs", "/tmp/p/link")).toBe(false);
    expect(canDropEntry(linkedView, "/tmp/p/a.txt", "/tmp/p/link")).toBe(false);
    expect(canDropEntry(linkedView, "/tmp/p/a.txt", "/tmp/p/docs")).toBe(true);
  });

  it("does not take a sibling whose name starts like the source for a folder below it", () => {
    const siblings = loaded(ROOT, dir("src"), dir("src2"));
    expect(canDropEntry({ root: siblings.root, rows: rowsOf(siblings) }, "/tmp/p/src", "/tmp/p/src2")).toBe(
      true,
    );
  });

  it("round-trips the drop target id, Windows paths with colons too", () => {
    expect(dropTargetPath(explorerDropTarget("C:\\Users\\Public"))).toBe("C:\\Users\\Public");
    expect(dropTargetPath(explorerDropTarget("/tmp/p"))).toBe("/tmp/p");
    expect(dropTargetPath("pane:1:left")).toBeUndefined();
  });
});

describe("renameTarget", () => {
  it("takes the input as typed and nothing for a blank or unchanged one", () => {
    expect(renameTarget("a.txt", "b.txt")).toBe("b.txt");
    expect(renameTarget("a.txt", "a.txt")).toBeUndefined();
    expect(renameTarget("a.txt", "  ")).toBeUndefined();
    expect(renameTarget("a.txt", "A.txt")).toBe("A.txt");
  });

  it("does not rename an untouched name with spaces at its ends, and does not trim a changed one", () => {
    // F2 and Enter on "notes.txt " (or " a ") change nothing.
    expect(renameTarget("notes.txt ", "notes.txt ")).toBeUndefined();
    expect(renameTarget(" a ", " a ")).toBeUndefined();
    expect(renameTarget("a ", "a ")).toBeUndefined();
    // A changed input goes as typed; the main process checks the name.
    expect(renameTarget("a", " a ")).toBe(" a ");
    expect(renameTarget(" a ", "a ")).toBe("a ");
  });
});

describe("keepsRename", () => {
  const tree = loaded(ROOT, file("a.txt"));
  const rows = rowsOf(tree);

  it("keeps the field while its row is visible or the service answers", () => {
    expect(keepsRename({ path: "/tmp/p/a.txt", busy: false }, rows)).toBe(true);
    expect(keepsRename({ path: "/tmp/p/gone.txt", busy: true }, rows)).toBe(true);
  });

  it("drops it when its row went without a blur (a late listing)", () => {
    expect(keepsRename({ path: "/tmp/p/gone.txt", busy: false }, rows)).toBe(false);
    expect(keepsRename({ path: "/tmp/p/a.txt", busy: false }, [])).toBe(false);
  });
});

describe("deletePromptOpens and deleteRuns", () => {
  const request = (id: number, path = "/tmp/p/a"): DeleteRequest => ({ id, key: "k1", path });

  it("opens the latest Delete while its folder shows and its entry is selected", () => {
    expect(deletePromptOpens(request(2), 2, "k1", "/tmp/p/a")).toBe(true);
  });

  it("drops an earlier Delete whose slow listing answers after a later one", () => {
    // Delete on a (id 1), then on b (id 2); a's listing answers last.
    expect(deletePromptOpens(request(1, "/tmp/p/a"), 2, "k1", "/tmp/p/b")).toBe(false);
    expect(deletePromptOpens(request(2, "/tmp/p/b"), 2, "k1", "/tmp/p/b")).toBe(true);
    // After b's dialog the pending id is cleared; a late answer of a still opens nothing.
    expect(deletePromptOpens(request(1, "/tmp/p/a"), undefined, "k1", "/tmp/p/a")).toBe(false);
  });

  it("drops it when the selection or the folder changed meanwhile", () => {
    expect(deletePromptOpens(request(3), 3, "k1", "/tmp/p/other")).toBe(false);
    expect(deletePromptOpens(request(3), 3, "k1", undefined)).toBe(false);
    expect(deletePromptOpens(request(3), 3, "k2", "/tmp/p/a")).toBe(false);
  });

  it("runs a confirmed delete only in the folder the dialog was opened for", () => {
    expect(deleteRuns("k1", "k1")).toBe(true);
    expect(deleteRuns("k1", "k2")).toBe(false);
    expect(deleteRuns("k1", undefined)).toBe(false);
  });
});

describe("renameSelection", () => {
  it("marks a file's name without its extension and all of a folder's or a dot file's", () => {
    expect(renameSelection("notes.txt", false)).toEqual([0, 5]);
    expect(renameSelection("a.tar.gz", false)).toEqual([0, 5]);
    expect(renameSelection(".bashrc", false)).toEqual([0, 7]);
    expect(renameSelection("v1.2", true)).toEqual([0, 4]);
  });
});

describe("countsEntries", () => {
  it("counts a real folder only, not a symlink to one", () => {
    const tree = loaded(ROOT, dir("docs"), {
      name: "link",
      kind: "symlink",
      size: 0,
      modified: 1,
      targetKind: "directory",
    });
    expect(countsEntries(row(tree, "/tmp/p/docs"))).toBe(true);
    expect(row(tree, "/tmp/p/link").folder).toBe(true);
    expect(countsEntries(row(tree, "/tmp/p/link"))).toBe(false);
  });
});

describe("deleteConfirmation", () => {
  it("names the file and says it is for good", () => {
    const text = deleteConfirmation("a.txt", false);
    expect(text.message).toContain("„a.txt“");
    expect(text.message).toMatch(/endgültig/);
    expect(text.confirm).toBe("Löschen");
  });

  it("names the direct entries of a folder, and none when they are unknown", () => {
    expect(deleteConfirmation("docs", true, 3).message).toContain("3 Einträge");
    expect(deleteConfirmation("docs", true, 1).message).toContain("1 Eintrag");
    expect(deleteConfirmation("docs", true, 0).message).toContain("leer");
    expect(deleteConfirmation("docs", true).message).not.toMatch(/\d/);
    expect(deleteConfirmation("docs", true).message).toMatch(/mit allem darin/);
  });
});

describe("actionErrorText", () => {
  it("names a taken name, a missing entry, no access and a refused name, never a path", () => {
    expect(actionErrorText("rename", "notes.txt", "EEXIST", "README.md")).toBe(
      "„README.md“ gibt es in diesem Ordner schon",
    );
    expect(actionErrorText("move", "a.txt", "EEXIST")).toBe("Im Ziel gibt es „a.txt“ schon");
    expect(actionErrorText("delete", "a.txt", "ENOENT")).toBe("„a.txt“ gibt es nicht mehr");
    expect(actionErrorText("move", "a.txt", "EACCES")).toBe("Kein Zugriff auf „a.txt“");
    expect(actionErrorText("rename", "a.txt", "EINVAL", "a:b")).toBe("„a:b“ ist kein gültiger Name");
    expect(actionErrorText("delete", "a.txt", "EINVAL")).toBe("„a.txt“ kann nicht gelöscht werden");
    expect(actionErrorText("download", "a.txt", "OTHER")).toBe("„a.txt“ konnte nicht heruntergeladen werden");
    expect(actionErrorText("reveal", "a.txt", "OTHER")).toBe("„a.txt“ konnte nicht gezeigt werden");
  });
});

describe("skippedText", () => {
  it("says how many entries a download skipped, nothing for none", () => {
    expect(skippedText(0)).toBeUndefined();
    expect(skippedText(1)).toBe("1 Eintrag übersprungen");
    expect(skippedText(2)).toBe("2 Einträge übersprungen");
  });
});

describe("the tree after an action", () => {
  const base = opened(loaded(ROOT, dir("docs"), dir("src"), file("a.txt")), "/tmp/p/src", file("main.ts"));

  it("after a rename: the entry has its new name, is selected, and its folder lists again", () => {
    const { tree, requests } = afterRename(base, row(base, "/tmp/p/src/main.ts"), "index.ts");
    expect(tree.selected).toBe("/tmp/p/src/index.ts");
    expect(entryRow(rowsOf(tree), "/tmp/p/src/index.ts")).toBeDefined();
    expect(paths(requests)).toEqual(["/tmp/p/src"]);
  });

  it("after a move into a closed folder: it opens, lists both folders, and the moved entry is selected", () => {
    const { tree, requests } = afterMove(base, row(base, "/tmp/p/a.txt"), "/tmp/p/docs");
    expect(entryRow(rowsOf(tree), "/tmp/p/a.txt")).toBeUndefined();
    expect(tree.expanded.has("/tmp/p/docs")).toBe(true);
    expect(tree.selected).toBe("/tmp/p/docs/a.txt");
    expect(paths(requests).sort()).toEqual(["/tmp/p", "/tmp/p/docs"]);
  });

  it("after a move into the root or an open folder: both list again, nothing else opens", () => {
    const up = afterMove(base, row(base, "/tmp/p/src/main.ts"), "/tmp/p");
    expect(paths(up.requests).sort()).toEqual(["/tmp/p", "/tmp/p/src"]);
    expect(up.tree.selected).toBe("/tmp/p/main.ts");
    const down = afterMove(base, row(base, "/tmp/p/a.txt"), "/tmp/p/src");
    expect(paths(down.requests).sort()).toEqual(["/tmp/p", "/tmp/p/src"]);
    expect([...down.tree.expanded]).toEqual(["/tmp/p/src"]);
  });

  it("after a delete: the entry is gone and its folder lists again", () => {
    const { tree, requests } = afterDelete(base, row(base, "/tmp/p/src"));
    expect(entryRow(rowsOf(tree), "/tmp/p/src")).toBeUndefined();
    expect(tree.expanded.has("/tmp/p/src")).toBe(false);
    expect(paths(requests)).toEqual(["/tmp/p"]);
  });

  it("after a failure: the folders involved list again, once each, and nothing else changes", () => {
    const { tree, requests } = afterFailure(base, ["/tmp/p/src", "/tmp/p/src", "/tmp/p/never"]);
    expect(paths(requests)).toEqual(["/tmp/p/src"]);
    expect(rowsOf(tree)).toEqual(rowsOf(base));
  });
});
