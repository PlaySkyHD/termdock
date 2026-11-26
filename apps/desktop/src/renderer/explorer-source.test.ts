// Issue #202 (openspec change explorer-panel): what the explorer panel follows.
import type { LayoutTab, LayoutWindow, SessionInfo } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import {
  asksDistro,
  DISTRO_RETRY_MAX_MS,
  distroAnswered,
  explorerPaneId,
  explorerTarget,
  knownDistro,
  needsDefaultDistro,
  sessionLocation,
  shortPath,
} from "./explorer-source.js";
import type { ViewRole } from "./terminal-controller.js";

function session(id: string, patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    name: id,
    state: "Running",
    launch: { backend: "wsl", distro: "Ubuntu", cwd: "/" },
    size: { cols: 80, rows: 24 },
    loggingEnabled: false,
    createdAt: "2026-11-26T10:00:00Z",
    updatedAt: "2026-11-26T10:00:00Z",
    ...patch,
  };
}

// Two panes side by side: p1 shows a, p2 shows b; p2 is active.
const TAB: LayoutTab = {
  id: "t1",
  root: {
    kind: "split",
    id: "s1",
    direction: "row",
    children: [
      { kind: "pane", id: "p1", sessionId: "a" },
      { kind: "pane", id: "p2", sessionId: "b" },
    ],
    sizes: [0.5, 0.5],
  },
  activePaneId: "p2",
};
const WINDOW: LayoutWindow = { id: "w", tabs: [TAB], activeTabId: "t1" };
const roles =
  (map: Record<string, ViewRole>) =>
  (paneId: string): ViewRole | undefined =>
    map[paneId];

describe("explorerPaneId", () => {
  it("follows the active pane when it writes", () => {
    expect(explorerPaneId(TAB, roles({ p1: "writer", p2: "writer" }))).toBe("p2");
  });

  it("follows the writing pane of the tab when the active one reads", () => {
    expect(explorerPaneId(TAB, roles({ p1: "writer", p2: "reader" }))).toBe("p1");
  });

  it("follows the active pane when no pane writes", () => {
    expect(explorerPaneId(TAB, roles({ p1: "reader" }))).toBe("p2");
  });
});

describe("explorerTarget", () => {
  const writers = roles({ p1: "writer", p2: "writer" });

  it("shows the current directory of the session of the pane", () => {
    const target = explorerTarget(WINDOW, [session("a"), session("b", { currentCwd: "/tmp/x" })], writers);
    expect(target).toMatchObject({
      kind: "folder",
      location: { backend: "wsl", distro: "Ubuntu", path: "/tmp/x" },
    });
  });

  it("changes its key with the folder and with the session", () => {
    const key = (sessions: SessionInfo[], roleOf = writers): string | undefined => {
      const target = explorerTarget(WINDOW, sessions, roleOf);
      return target.kind === "folder" ? target.key : undefined;
    };
    const first = key([session("a", { currentCwd: "/tmp" }), session("b", { currentCwd: "/tmp" })]);
    const cd = key([session("a", { currentCwd: "/tmp" }), session("b", { currentCwd: "/srv" })]);
    const otherPane = key(
      [session("a", { currentCwd: "/tmp" }), session("b", { currentCwd: "/tmp" })],
      roles({ p1: "writer", p2: "reader" }),
    );
    expect(new Set([first, cd, otherPane]).size).toBe(3);
  });

  it("names why there is no folder", () => {
    expect(explorerTarget({ id: "w", tabs: [] }, [], writers)).toEqual({ kind: "noTab" });
    expect(explorerTarget(WINDOW, [], writers)).toEqual({ kind: "noSession", sessionId: "b" });
    expect(explorerTarget(WINDOW, [session("b", { state: "Exited" })], writers).kind).toBe("notRunning");
    expect(explorerTarget(WINDOW, [session("b")], writers).kind).toBe("unknownCwd");
    const noDistro = session("b", { currentCwd: "/tmp", launch: { backend: "wsl", cwd: "/" } });
    expect(explorerTarget(WINDOW, [noDistro], writers).kind).toBe("unknownCwd");
  });

  it("takes the default distro of WSL for a session that names none (pinned after session.created)", () => {
    const noDistro = session("b", { currentCwd: "/tmp", launch: { backend: "wsl", cwd: "/" } });
    expect(explorerTarget(WINDOW, [noDistro], writers, "Debian")).toMatchObject({
      kind: "folder",
      location: { backend: "wsl", distro: "Debian", path: "/tmp" },
    });
    // Only such a session makes the window ask for the default distro (a wsl.exe call in the core).
    expect(needsDefaultDistro(explorerTarget(WINDOW, [noDistro], writers))).toBe(true);
    expect(needsDefaultDistro(explorerTarget(WINDOW, [noDistro], writers, "Debian"))).toBe(false);
    const unknown = session("b", { launch: { backend: "wsl", cwd: "/" } });
    expect(needsDefaultDistro(explorerTarget(WINDOW, [unknown], writers))).toBe(false);
    expect(needsDefaultDistro(explorerTarget(WINDOW, [session("b")], writers))).toBe(false);
    // A named distro wins.
    expect(explorerTarget(WINDOW, [session("b", { currentCwd: "/tmp" })], writers, "Debian")).toMatchObject({
      location: { distro: "Ubuntu" },
    });
  });
});

describe("sessionLocation", () => {
  it("is a Linux path in the distro of a WSL session and a Windows path otherwise", () => {
    expect(sessionLocation(session("a"), "/home")).toEqual({
      backend: "wsl",
      distro: "Ubuntu",
      path: "/home",
    });
    const windows = session("w", { launch: { backend: "windows", shell: "cmd", cwd: "C:\\" } });
    expect(sessionLocation(windows, "C:\\Temp")).toEqual({ backend: "windows", path: "C:\\Temp" });
  });
});

describe("shortPath", () => {
  it("keeps a short path and cuts a long one from the left", () => {
    expect(shortPath("/tmp/x")).toBe("/tmp/x");
    const long = `/very/long/${"a".repeat(60)}/end`;
    const short = shortPath(long, 20);
    expect(short).toHaveLength(20);
    expect(short.startsWith("…")).toBe(true);
    expect(short.endsWith("/end")).toBe(true);
  });
});

describe("default distro lookup", () => {
  it("asks only when needed, keeps a named answer per core generation", () => {
    expect(asksDistro(undefined, 0, false, 0)).toBe(false);
    expect(asksDistro(undefined, 0, true, 0)).toBe(true);
    const known = distroAnswered(undefined, 0, "Ubuntu", 10);
    expect(knownDistro(known, 0)).toBe("Ubuntu");
    expect(asksDistro(known, 0, true, 10_000_000)).toBe(false);
    // A new core may have another default.
    expect(knownDistro(known, 1)).toBeUndefined();
    expect(asksDistro(known, 1, true, 10)).toBe(true);
  });

  it("asks again after a failure or an answer without a name, with a growing wait", () => {
    const first = distroAnswered(undefined, 0, undefined, 1_000);
    expect(knownDistro(first, 0)).toBeUndefined();
    expect(asksDistro(first, 0, true, 2_999)).toBe(false);
    expect(asksDistro(first, 0, true, 3_000)).toBe(true);
    const second = distroAnswered(first, 0, undefined, 3_000);
    expect(second.retryAt).toBe(7_000);
    let lookup = second;
    for (let i = 0; i < 10; i += 1) lookup = distroAnswered(lookup, 0, undefined, 0);
    expect(lookup.retryAt).toBe(DISTRO_RETRY_MAX_MS);
    expect(knownDistro(distroAnswered(lookup, 0, "Debian", 0), 0)).toBe("Debian");
  });
});
