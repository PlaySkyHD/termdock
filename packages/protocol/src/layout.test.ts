import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "./frame.js";
import type { Frame } from "./frame.js";
import { parseRequest, parseResponse, validateLayoutDocument } from "./guards.js";
import {
  LAYOUT_VERSION,
  MAX_LAYOUT_BYTES,
  MAX_LAYOUT_ID_LENGTH,
  MAX_LAYOUT_WINDOWS,
  MAX_PANES_PER_TAB,
  MAX_TAB_TITLE_LENGTH,
  MAX_TABS_PER_WINDOW,
} from "./model.js";

type Json = Record<string, unknown>;

function pane(id: string, sessionId = `s-${id}`): Json {
  return { kind: "pane", id, sessionId };
}

function split(id: string, children: Json[], sizes?: number[], direction = "row"): Json {
  return { kind: "split", id, direction, children, sizes: sizes ?? children.map(() => 1 / children.length) };
}

function tab(id: string, root: Json, activePaneId: string): Json {
  return { id, root, activePaneId };
}

function window(id: string, tabs: Json[], activeTabId?: string): Json {
  return { id, tabs, activeTabId: activeTabId ?? (tabs[0] as Json)["id"] };
}

function document(windows: Json[]): Json {
  return { version: LAYOUT_VERSION, windows };
}

function valid(): Json {
  return document([
    {
      ...window("w1", [
        { ...tab("t1", split("sp1", [pane("p1"), pane("p2")], [0.3, 0.7], "column"), "p2"), title: "Build" },
        tab("t2", pane("p3", "gone"), "p3"),
      ]),
      bounds: { x: -1920, y: 40, width: 1200, height: 800 },
      maximized: false,
      sidebarVisible: true,
      sidebarWidth: 260,
    },
    window("w2", [tab("t3", pane("p4"), "p4")]),
  ]);
}

function message(value: unknown): string {
  const result = validateLayoutDocument(value);
  if (result.ok) throw new Error("expected the layout to be rejected");
  expect(result.error.code).toBe("bad_request");
  return result.error.message;
}

describe("validateLayoutDocument", () => {
  it("accepts a full document and returns it unchanged, also for a session that does not exist", () => {
    const doc = valid();
    const result = validateLayoutDocument(doc);
    expect(result).toEqual({ ok: true, value: doc });
  });

  it("accepts a document without windows and windows without optional fields", () => {
    expect(validateLayoutDocument(document([])).ok).toBe(true);
    expect(validateLayoutDocument(document([window("w", [tab("t", pane("p"), "p")])])).ok).toBe(true);
  });

  it("accepts exactly four panes in a tab, also nested", () => {
    expect(MAX_PANES_PER_TAB).toBe(4);
    const nested = split("a", [split("b", [pane("p1"), pane("p2")]), split("c", [pane("p3"), pane("p4")])]);
    expect(validateLayoutDocument(document([window("w", [tab("t", nested, "p4")])])).ok).toBe(true);
  });

  it("rejects more than four panes in one tab but allows four in each of two tabs", () => {
    const five = split("a", [pane("p1"), pane("p2"), pane("p3"), split("b", [pane("p4"), pane("p5")])]);
    expect(message(document([window("w", [tab("t", five, "p1")])]))).toContain("4");
    const twoTabs = document([
      window("w", [
        tab("t1", split("a", [pane("p1"), pane("p2"), pane("p3"), pane("p4")]), "p1"),
        tab("t2", split("b", [pane("p5"), pane("p6"), pane("p7"), pane("p8")]), "p5"),
      ]),
    ]);
    expect(validateLayoutDocument(twoTabs).ok).toBe(true);
  });

  it("rejects a duplicate id and names it, across windows, tabs, panes and splits", () => {
    const sameInTwoWindows = document([
      window("w1", [tab("t1", pane("p1"), "p1")]),
      window("w2", [tab("t2", pane("p1"), "p1")]),
    ]);
    expect(message(sameInTwoWindows)).toContain("p1");
    expect(message(document([window("x", [tab("t", pane("x"), "x")])]))).toContain("x");
    expect(message(document([window("w", [tab("t", split("t", [pane("a"), pane("b")]), "a")])]))).toContain(
      '"t"',
    );
  });

  it("rejects sizes that do not fit the children", () => {
    const wrap = (root: Json): Json => document([window("w", [tab("t", root, "a")])]);
    expect(message(wrap(split("s", [pane("a"), pane("b"), pane("c")], [0.5, 0.5])))).toContain("sizes");
    expect(message(wrap(split("s", [pane("a"), pane("b")], [0.5, 1])))).toContain("sizes");
    expect(message(wrap(split("s", [pane("a"), pane("b")], [1, 0])))).toContain("sizes");
    expect(message(wrap(split("s", [pane("a"), pane("b")], [1.2, -0.2])))).toContain("sizes");
    expect(message(wrap(split("s", [pane("a"), pane("b")], [0.5, "0.5" as unknown as number])))).toContain(
      "sizes",
    );
    expect(validateLayoutDocument(wrap(split("s", [pane("a"), pane("b")], [0.333, 0.667]))).ok).toBe(true);
  });

  it("rejects a split with fewer than two children", () => {
    const one = document([window("w", [tab("t", split("s", [pane("a")], [1]), "a")])]);
    expect(message(one)).toContain("children");
  });

  it("rejects active ids that do not exist", () => {
    expect(message(document([window("w", [tab("t", pane("p"), "p")], "nope")]))).toContain("activeTabId");
    expect(message(document([window("w", [tab("t", pane("p"), "q")])]))).toContain("activePaneId");
    const otherTab = document([window("w", [tab("t1", pane("p1"), "p2"), tab("t2", pane("p2"), "p2")])]);
    expect(message(otherTab)).toContain("activePaneId");
    const splitId = document([window("w", [tab("t", split("s", [pane("a"), pane("b")]), "s")])]);
    expect(message(splitId)).toContain("activePaneId");
  });

  it("accepts a window without tabs, but only without activeTabId", () => {
    expect(validateLayoutDocument(document([{ id: "w", tabs: [], sidebarVisible: true }])).ok).toBe(true);
    expect(message(document([{ id: "w", tabs: [], activeTabId: "t" }]))).toContain("activeTabId");
  });

  it("requires a valid activeTabId in a window with tabs", () => {
    const withTab = { id: "w", tabs: [tab("t", pane("p"), "p")] };
    expect(message(document([withTab]))).toContain("activeTabId");
  });

  it("rejects unknown keys at every level", () => {
    const doc = valid();
    expect(message({ ...doc, extra: 1 })).toContain("extra");
    const patched = (path: (copy: Json) => Json): unknown => {
      const copy = structuredClone(doc);
      path(copy)["extra"] = 1;
      return message(copy);
    };
    const firstWindow = (copy: Json): Json => (copy["windows"] as Json[])[0] as Json;
    const tabOf = (copy: Json): Json => (firstWindow(copy)["tabs"] as Json[])[0] as Json;
    const rootOf = (copy: Json): Json => tabOf(copy)["root"] as Json;
    expect(patched(firstWindow)).toContain("extra");
    expect(patched(tabOf)).toContain("extra");
    expect(patched(rootOf)).toContain("extra");
    expect(patched((copy) => (rootOf(copy)["children"] as Json[])[0] as Json)).toContain("extra");
    expect(patched((copy) => firstWindow(copy)["bounds"] as Json)).toContain("extra");
  });

  it("limits ids and session ids to 64 characters", () => {
    const long = "x".repeat(MAX_LAYOUT_ID_LENGTH);
    const doc = (id: string, sessionId: string): Json =>
      document([window("w", [tab("t", pane(id, sessionId), id)])]);
    expect(validateLayoutDocument(doc(long, long)).ok).toBe(true);
    expect(message(doc(long + "x", "s"))).toContain("id");
    expect(message(doc("p", long + "x"))).toContain("sessionId");
  });

  it("limits the serialized document to MAX_LAYOUT_BYTES", () => {
    const id = (n: number): string => `${n}`.padStart(MAX_LAYOUT_ID_LENGTH, "i");
    const windows = Array.from({ length: MAX_LAYOUT_WINDOWS }, (_, w) =>
      window(
        id(w),
        Array.from({ length: MAX_TABS_PER_WINDOW }, (_, t) => {
          const n = 1000 + w * 100 + t;
          return tab(id(n), pane(id(100_000 + n), id(200_000 + n)), id(100_000 + n));
        }),
      ),
    );
    expect(JSON.stringify(document(windows)).length).toBeGreaterThan(MAX_LAYOUT_BYTES);
    expect(message(document(windows))).toContain("bytes");
  });

  it("rejects a wrong version and wrong shapes with a readable message", () => {
    expect(message({ ...valid(), version: 2 })).toContain("version");
    expect(message(null)).toContain("object");
    expect(message({ version: LAYOUT_VERSION })).toContain("windows");
    expect(message(document([window("w", [tab("t", { kind: "tabs", id: "x" }, "x")])]))).toContain("kind");
    expect(
      message(
        document([window("w", [tab("t", split("s", [pane("a"), pane("b")], undefined, "diag"), "a")])]),
      ),
    ).toContain("direction");
    expect(message(document([window("w", [tab("t", { kind: "pane", id: "a" }, "a")])]))).toContain(
      "sessionId",
    );
  });

  it("rejects documents with too many windows or tabs or a very long title", () => {
    const tabOf = (n: number): Json => tab(`t${n}`, pane(`p${n}`), `p${n}`);
    const windows = (n: number): Json[] => Array.from({ length: n }, (_, i) => window(`w${i}`, [tabOf(i)]));
    expect(validateLayoutDocument(document(windows(MAX_LAYOUT_WINDOWS))).ok).toBe(true);
    expect(message(document(windows(MAX_LAYOUT_WINDOWS + 1)))).toContain("windows");
    const tabs = (n: number): Json[] => Array.from({ length: n }, (_, i) => tabOf(i));
    expect(validateLayoutDocument(document([window("w", tabs(MAX_TABS_PER_WINDOW))])).ok).toBe(true);
    expect(message(document([window("w", tabs(MAX_TABS_PER_WINDOW + 1))]))).toContain("tabs");
    const titled = (length: number): Json => ({ ...tabOf(0), title: "x".repeat(length) });
    expect(validateLayoutDocument(document([window("w", [titled(MAX_TAB_TITLE_LENGTH)])])).ok).toBe(true);
    expect(message(document([window("w", [titled(MAX_TAB_TITLE_LENGTH + 1)])]))).toContain("title");
  });

  it("rejects invalid window fields", () => {
    const base = window("w", [tab("t", pane("p"), "p")]);
    for (const patch of [
      { bounds: { x: 0, y: 0, width: 0, height: 10 } },
      { bounds: { x: 0.5, y: 0, width: 10, height: 10 } },
      { bounds: { x: 0, y: 0, width: 10 } },
      { maximized: "yes" },
      { sidebarVisible: 1 },
      { sidebarWidth: -5 },
    ]) {
      expect(validateLayoutDocument(document([{ ...base, ...patch }])).ok).toBe(false);
    }
  });

  it("does not recurse into deeply nested input", () => {
    let node: Json = pane("leaf");
    for (let depth = 0; depth < 5000; depth += 1) node = split(`s${depth}`, [node, pane(`p${depth}`)]);
    expect(message(document([window("w", [tab("t", node, "leaf")])]))).toContain("4");
  });
});

function frame(header: unknown): Frame {
  return new FrameDecoder().push(encodeFrame(header))[0] as Frame;
}

describe("layout methods", () => {
  it("parses layout.get and layout.save requests", () => {
    const get = parseRequest(frame({ kind: "request", id: "r", method: "layout.get", params: {} }));
    expect(get.ok).toBe(true);
    const save = parseRequest(
      frame({
        kind: "request",
        id: "r",
        method: "layout.save",
        params: { layout: valid(), baseRevision: 2 },
      }),
    );
    expect(save).toMatchObject({ ok: true, value: { params: { baseRevision: 2 } } });
    const unconditional = parseRequest(
      frame({ kind: "request", id: "r", method: "layout.save", params: { layout: valid() } }),
    );
    expect(unconditional.ok).toBe(true);
  });

  it("rejects layout.save with an invalid layout or base revision", () => {
    const save = (params: unknown) =>
      parseRequest(frame({ kind: "request", id: "r", method: "layout.save", params }));
    expect(save({}).ok).toBe(false);
    expect(save({ layout: document([{ id: "w", tabs: [], activeTabId: "t" }]) }).ok).toBe(false);
    for (const baseRevision of [-1, 1.5, "1", null]) {
      expect(save({ layout: valid(), baseRevision }).ok).toBe(false);
    }
  });

  it("parses layout.get and layout.save responses", () => {
    const get = (result: unknown) =>
      parseResponse(frame({ kind: "response", id: "r", result }), "layout.get");
    expect(get({ revision: 0 }).ok).toBe(true);
    expect(get({ revision: 3, layout: valid() }).ok).toBe(true);
    expect(get({ layout: valid() }).ok).toBe(false);
    expect(get({ revision: 3, layout: document([{ id: "w", tabs: [], activeTabId: "t" }]) }).ok).toBe(false);
    const save = (result: unknown) =>
      parseResponse(frame({ kind: "response", id: "r", result }), "layout.save");
    expect(save({ revision: 1 }).ok).toBe(true);
    expect(save({}).ok).toBe(false);
    expect(save({ revision: -1 }).ok).toBe(false);
  });
});
