import type { HistoryHit, HistorySearchResult, SessionInfo } from "@termdock/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELETED_SESSION,
  groupHits,
  hitAt,
  HistorySearchModel,
  moveSelection,
  QUERY_TOO_LONG,
  SEARCH_DELAY_MS,
  SEARCH_LIMIT,
  splitHit,
} from "./history-search.js";

function session(id: string, name: string, state: SessionInfo["state"] = "Running"): SessionInfo {
  return {
    id,
    name,
    state,
    launch: { backend: "wsl", cwd: "/" },
    size: { cols: 80, rows: 24 },
    loggingEnabled: true,
    createdAt: "2026-11-14T10:00:00Z",
    updatedAt: "2026-11-14T10:00:00Z",
  };
}

const hit = (sessionId: string, timestamp: number, line: string, offset = 0): HistoryHit => ({
  sessionId,
  timestamp,
  line,
  offset,
});

describe("groupHits", () => {
  const sessions = [session("s1", "Build"), session("s2", "Logs"), session("s3", "Old", "Archived")];

  it("groups by session in the order of the newest hit, keeping the order of the hits", () => {
    const groups = groupHits(
      [hit("s2", 9, "a"), hit("s1", 8, "b"), hit("s2", 7, "c"), hit("s3", 6, "d")],
      sessions,
    );

    expect(groups.map((group) => [group.name, group.hits.map((each) => each.line)])).toEqual([
      ["Logs", ["a", "c"]],
      ["Build", ["b"]],
      ["Old", ["d"]],
    ]);
    expect(groups.map((group) => group.state)).toEqual(["Running", "Running", "Archived"]);
  });

  it("names a session the list does not have as deleted", () => {
    const [group] = groupHits([hit("gone", 1, "x")], sessions);

    expect(group).toMatchObject({ sessionId: "gone", name: DELETED_SESSION, state: undefined });
  });

  it("has no groups without hits", () => {
    expect(groupHits([], sessions)).toEqual([]);
  });
});

describe("splitHit", () => {
  it("cuts the line at the match, keeping its original case", () => {
    expect(splitHit(hit("s1", 1, "Build ERROR in file", 6), "error")).toEqual({
      before: "Build ",
      match: "ERROR",
      after: " in file",
    });
  });

  it("stays inside the line for an offset or query that does not fit", () => {
    expect(splitHit(hit("s1", 1, "abc", 2), "long query")).toEqual({ before: "ab", match: "c", after: "" });
    expect(splitHit(hit("s1", 1, "abc", 9), "x")).toEqual({ before: "abc", match: "", after: "" });
    expect(splitHit(hit("s1", 1, "abc", -3), "ab")).toEqual({ before: "", match: "ab", after: "c" });
  });

  it("returns text only: markup in a line stays markup text", () => {
    const parts = splitHit(hit("s1", 1, "<script>alert(1)</script>", 1), "script");

    expect(parts).toEqual({ before: "<", match: "script", after: ">alert(1)</script>" });
  });
});

describe("HistorySearchModel", () => {
  const sessions = [session("s1", "Build"), session("s2", "Logs")];
  const timers = {
    set: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(answer: (query: string) => Promise<HistorySearchResult>) {
    const searchHistory = vi.fn((query: string, _limit?: number) => answer(query));
    const model = new HistorySearchModel({ searchHistory }, () => sessions, timers);
    let changes = 0;
    model.subscribe(() => changes++);
    return { model, searchHistory, changes: () => changes };
  }

  const found =
    (...hits: HistoryHit[]) =>
    async (): Promise<HistorySearchResult> => ({
      hits,
      truncated: false,
    });

  it("starts idle and searches only after the pause, with the trimmed text and the limit", async () => {
    const { model, searchHistory } = setup(found(hit("s1", 5, "an error here", 3)));

    model.setQuery(" err");
    model.setQuery(" error ");
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS - 1);
    expect(searchHistory).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(searchHistory).toHaveBeenCalledTimes(1);
    expect(searchHistory).toHaveBeenCalledWith("error", SEARCH_LIMIT);
    expect(model.getState()).toMatchObject({
      status: "done",
      query: "error",
      total: 1,
      truncated: false,
      groups: [{ name: "Build" }],
    });
  });

  it("searches at once on Enter and does not search again for the pending text", async () => {
    const { model, searchHistory } = setup(found());

    model.setQuery("abc");
    await model.run("abc");
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS * 2);

    expect(searchHistory).toHaveBeenCalledTimes(1);
    expect(model.getState()).toMatchObject({ status: "done", total: 0 });
  });

  it("shows searching while the core works, and reports truncated results", async () => {
    let finish!: (result: HistorySearchResult) => void;
    const { model } = setup(() => new Promise((resolve) => (finish = resolve)));

    const running = model.run("x");
    expect(model.getState()).toEqual({ status: "searching", query: "x" });
    finish({ hits: [hit("s2", 1, "x")], truncated: true });
    await running;

    expect(model.getState()).toMatchObject({ status: "done", truncated: true, total: 1 });
  });

  it("lets only the newest search count, however late an older answer arrives", async () => {
    const pending = new Map<string, (result: HistorySearchResult) => void>();
    const { model } = setup((query) => new Promise((resolve) => pending.set(query, resolve)));

    const first = model.run("first");
    const second = model.run("second");
    pending.get("second")!({ hits: [hit("s1", 2, "second")], truncated: false });
    await second;
    pending.get("first")!({ hits: [hit("s2", 1, "first")], truncated: false });
    await first;

    expect(model.getState()).toMatchObject({ status: "done", query: "second", total: 1 });
  });

  it("drops the answer of a running search as soon as the text changes", async () => {
    let finish!: (result: HistorySearchResult) => void;
    const { model } = setup(() => new Promise((resolve) => (finish = resolve)));

    const running = model.run("abc");
    model.setQuery("abcd");
    finish({ hits: [hit("s1", 1, "abc")], truncated: false });
    await running;

    expect(model.getState()).toEqual({ status: "searching", query: "abc" });
  });

  it("drops a running search when the text is cleared", async () => {
    let finish!: (result: HistorySearchResult) => void;
    const { model } = setup(() => new Promise((resolve) => (finish = resolve)));

    const running = model.run("x");
    model.setQuery("   ");
    finish({ hits: [hit("s1", 1, "x")], truncated: false });
    await running;

    expect(model.getState()).toEqual({ status: "idle" });
  });

  it("reports an error of the search with its message", async () => {
    const { model } = setup(async () => {
      throw new Error("[internal] disk gone");
    });

    await model.run("x");

    expect(model.getState()).toEqual({ status: "error", query: "x", message: "[internal] disk gone" });
  });

  it("refuses a query over the limit without asking the core", async () => {
    const { model, searchHistory } = setup(found());

    await model.run("q".repeat(257));

    expect(searchHistory).not.toHaveBeenCalled();
    expect(model.getState()).toMatchObject({ status: "error", message: QUERY_TOO_LONG });
  });

  it("does nothing any more after dispose: no timer, no answer, no listener call", async () => {
    let finish!: (result: HistorySearchResult) => void;
    const { model, searchHistory, changes } = setup(() => new Promise((resolve) => (finish = resolve)));

    const running = model.run("x");
    const before = changes();
    model.setQuery("later");
    model.dispose();
    finish({ hits: [hit("s1", 1, "x")], truncated: false });
    await running;
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS * 2);

    expect(searchHistory).toHaveBeenCalledTimes(1);
    expect(changes()).toBe(before);
    expect(model.getState()).toEqual({ status: "searching", query: "x" });
  });
});

describe("moveSelection", () => {
  it("starts at the first hit going down and at the last going up", () => {
    expect(moveSelection(5, -1, "ArrowDown")).toBe(0);
    expect(moveSelection(5, -1, "ArrowUp")).toBe(4);
  });

  it("steps by one and stops at both ends instead of wrapping", () => {
    expect(moveSelection(5, 1, "ArrowDown")).toBe(2);
    expect(moveSelection(5, 1, "ArrowUp")).toBe(0);
    expect(moveSelection(5, 4, "ArrowDown")).toBe(4);
    expect(moveSelection(5, 0, "ArrowUp")).toBe(0);
  });

  it("jumps to the first or last hit with Home and End", () => {
    expect(moveSelection(5, 2, "Home")).toBe(0);
    expect(moveSelection(5, 2, "End")).toBe(4);
  });

  it("selects nothing without hits and repairs an index outside the list", () => {
    expect(moveSelection(0, -1, "ArrowDown")).toBe(-1);
    expect(moveSelection(0, 3, "End")).toBe(-1);
    expect(moveSelection(3, 9, "ArrowUp")).toBe(2);
  });
});

describe("hitAt", () => {
  const sessions = [session("s1", "Build"), session("s2", "Logs")];
  const groups = groupHits([hit("s1", 9, "a"), hit("s2", 8, "b"), hit("s1", 7, "c")], sessions);

  it("counts through the groups in display order", () => {
    // Groups: Build [a, c], Logs [b].
    expect(hitAt(groups, 0)?.hit.line).toBe("a");
    expect(hitAt(groups, 1)?.hit.line).toBe("c");
    expect(hitAt(groups, 2)).toMatchObject({ group: { name: "Logs" }, hit: { line: "b" } });
  });

  it("has no hit outside the list", () => {
    expect(hitAt(groups, -1)).toBeUndefined();
    expect(hitAt(groups, 3)).toBeUndefined();
  });
});

describe("HistorySearchModel selection", () => {
  const sessions = [session("s1", "Build"), session("s2", "Logs")];
  const answer = async (): Promise<HistorySearchResult> => ({
    hits: [hit("s1", 9, "one"), hit("s2", 8, "two"), hit("s2", 7, "three")],
    truncated: false,
  });
  async function searched() {
    const searchHistory = vi.fn((_query: string, _limit?: number) => answer());
    const model = new HistorySearchModel({ searchHistory }, () => sessions);
    await model.run("o");
    return { model, searchHistory };
  }
  const selected = (model: HistorySearchModel): number | undefined => {
    const view = model.getState();
    return view.status === "done" ? view.selected : undefined;
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts without a selection and moves over the groups, stopping at the end", async () => {
    const { model } = await searched();
    expect(selected(model)).toBe(-1);

    for (let step = 0; step < 4; step++) expect(model.move("ArrowDown")).toBe(true);

    expect(selected(model)).toBe(2);
    expect(model.move("Home")).toBe(true);
    expect(selected(model)).toBe(0);
  });

  it("leaves Home and End to the text field as long as nothing is selected", async () => {
    const { model } = await searched();

    expect(model.move("Home")).toBe(false);
    expect(model.move("End")).toBe(false);
    expect(selected(model)).toBe(-1);
  });

  it("ignores the keys without results", () => {
    const model = new HistorySearchModel({ searchHistory: vi.fn() }, () => sessions);

    expect(model.move("ArrowDown")).toBe(false);
  });

  it("searches with Enter without a selection and opens the selected hit with Enter", async () => {
    const { model, searchHistory } = await searched();
    expect(model.activate("o")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(searchHistory).toHaveBeenCalledTimes(2);

    model.move("ArrowUp"); // from nothing: the last hit
    // Groups: Build [one], Logs [two, three]; the last hit belongs to Logs.
    expect(model.activate("o")).toBe("s2");
    expect(searchHistory).toHaveBeenCalledTimes(2);
  });

  it("searches instead of opening once the text changed after the results", async () => {
    const { model, searchHistory } = await searched();
    model.move("ArrowDown");

    model.setQuery("ou");
    expect(selected(model)).toBe(-1);
    expect(model.move("ArrowDown")).toBe(false);
    expect(model.activate("ou")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);

    expect(searchHistory).toHaveBeenLastCalledWith("ou", SEARCH_LIMIT);
  });

  it("resets the selection when new results arrive", async () => {
    const { model } = await searched();
    model.move("ArrowUp");
    expect(selected(model)).toBe(2);

    await model.run("o");

    expect(selected(model)).toBe(-1);
  });
});
