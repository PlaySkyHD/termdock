// Issue #202 (openspec change explorer-panel): size, visibility and texts of the explorer panel.
import { describe, expect, it } from "vitest";
import {
  EXPLORER_DEFAULT_WIDTH,
  EXPLORER_MAX_WIDTH,
  EXPLORER_MIN_WIDTH,
  explorerVisible,
  explorerWidth,
  hintText,
  listErrorText,
  openErrorText,
  panelView,
  PANES_MIN_WIDTH,
  targetText,
} from "./explorer-view.js";
import type { SessionInfo } from "@termdock/protocol";
import type { FileListResult, FileLocation } from "../shared/files.js";
import type { ExplorerTarget } from "./explorer-source.js";
import { finishLoad, loadRoot, refreshAll, treeFor } from "./explorer-tree.js";
import { UiStore } from "./ui-store.js";

const LOCATION: FileLocation = { backend: "wsl", distro: "Ubuntu", path: "/tmp/x" };
const SESSION = { id: "s" } as SessionInfo;
const FOLDER: ExplorerTarget = { kind: "folder", session: SESSION, location: LOCATION, key: "k" };

describe("panelView", () => {
  const answered = (result: FileListResult) => {
    const { tree, request } = loadRoot(treeFor(LOCATION));
    return finishLoad(tree, request, result);
  };

  it("names the target without a folder", () => {
    expect(panelView({ kind: "notRunning", session: SESSION, state: "Exited" }, undefined)).toEqual({
      state: "notRunning",
      message: "Session läuft nicht",
      rows: [],
    });
    expect(panelView({ kind: "unknownCwd", session: SESSION }, undefined).message).toBe(
      "Verzeichnis unbekannt",
    );
  });

  it("shows loading, the error, the empty folder and the tree", () => {
    expect(panelView(FOLDER, undefined).state).toBe("loading");
    expect(panelView(FOLDER, loadRoot(treeFor(LOCATION)).tree).message).toBe("Lädt …");
    expect(panelView(FOLDER, answered({ ok: false, code: "ENOENT" }))).toEqual({
      state: "error",
      message: "Ordner nicht gefunden",
      rows: [],
    });
    const empty: FileListResult = { ok: true, entries: [], truncated: false, total: 0 };
    expect(panelView(FOLDER, answered(empty))).toMatchObject({ state: "empty", message: "Ordner ist leer" });
    const one = answered({
      ok: true,
      entries: [{ name: "a", kind: "file", size: 1, modified: 1 }],
      truncated: false,
      total: 1,
    });
    expect(panelView(FOLDER, one)).toMatchObject({ state: "listed", rows: [{ kind: "entry", name: "a" }] });
    // A refresh keeps the tree until its answer.
    expect(panelView(FOLDER, refreshAll(one).tree).state).toBe("listed");
  });

  it("names the rows that are not entries", () => {
    expect(hintText({ kind: "loading", path: "/a", depth: 1 })).toBe("Lädt …");
    expect(hintText({ kind: "empty", path: "/a", depth: 1 })).toBe("Leer");
    expect(hintText({ kind: "error", path: "/a", depth: 1, code: "EACCES" })).toBe(
      "Kein Zugriff auf den Ordner",
    );
    expect(hintText({ kind: "truncated", path: "/a", depth: 0, shown: 5000, total: 5003 })).toBe(
      "5000 von 5003 Einträgen angezeigt",
    );
  });
});

describe("explorer width", () => {
  it("takes the default without a stored width and keeps the limits", () => {
    expect(explorerWidth(undefined)).toBe(EXPLORER_DEFAULT_WIDTH);
    expect(explorerWidth(Number.NaN)).toBe(EXPLORER_DEFAULT_WIDTH);
    expect(explorerWidth(10)).toBe(EXPLORER_MIN_WIDTH);
    expect(explorerWidth(5000)).toBe(EXPLORER_MAX_WIDTH);
    expect(explorerWidth(301.6)).toBe(302);
  });

  it("leaves the panes their minimum, but never goes below its own", () => {
    expect(explorerWidth(500, 700)).toBe(700 - PANES_MIN_WIDTH);
    expect(explorerWidth(500, 300)).toBe(EXPLORER_MIN_WIDTH);
  });
});

describe("explorer in the store", () => {
  it("shows by default and keeps visibility and width in the window of the layout", () => {
    const store = new UiStore({ newId: () => "w" });
    expect(explorerVisible(store.getState().window)).toBe(true);

    store.toggleExplorer();
    expect(store.getState().window.explorerVisible).toBe(false);
    store.showExplorer();
    expect(store.getState().window.explorerVisible).toBe(true);

    store.setExplorerWidth(5000);
    expect(store.getState().window.explorerWidth).toBe(EXPLORER_MAX_WIDTH);
    const before = store.getState();
    store.setExplorerWidth(EXPLORER_MAX_WIDTH + 10);
    expect(store.getState()).toBe(before);
  });

  it("restores a window with a hidden panel and its width", () => {
    const store = new UiStore({ newId: () => "x" });
    store.loadWindow({ id: "w", tabs: [], explorerVisible: false, explorerWidth: 333 });
    expect(explorerVisible(store.getState().window)).toBe(false);
    expect(store.getState().window.explorerWidth).toBe(333);
  });
});

describe("explorer texts", () => {
  it("names every code of the file service in words", () => {
    for (const code of ["ENOENT", "EACCES", "EEXIST", "EINVAL", "OTHER"] as const) {
      expect(listErrorText(code)).not.toContain(code);
      expect(openErrorText("a.txt", code)).toContain("a.txt");
    }
    expect(openErrorText("tool.exe", "EINVAL")).toContain("Programme");
  });

  it("names the state of a panel without a folder", () => {
    expect(targetText({ kind: "noTab" })).toBe("Kein Tab offen");
    expect(targetText({ kind: "noSession", sessionId: "s" })).toBe("Session nicht gefunden");
  });
});
