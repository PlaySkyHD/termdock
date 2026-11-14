import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_HISTORY_HITS, MAX_HISTORY_LINE_LENGTH } from "@termdock/protocol";
import { AnsiStripper, MAX_SEARCH_LINE_BUFFER, searchHistory, storeSource } from "./history-search.js";
import type { HistorySearchSource } from "./history-search.js";
import { HistoryStore } from "./history-store.js";

const KIB = 1024;
const cleanups: Array<() => Promise<void> | void> = [];
const encoder = new TextEncoder();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "termdock-search-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeStore(dataDir: string, limit = 64 * KIB): HistoryStore {
  let t = 1_700_000_000_000;
  const store = new HistoryStore({
    dataDir,
    getSettings: () => ({ historyLimitBytes: limit }),
    now: () => (t += 1),
    flushDelayMs: 1,
  });
  cleanups.push(() => store.dispose());
  return store;
}

/** An in-memory source: entries per session, one timestamp per entry counting from 1000. */
function memorySource(sessions: Record<string, Array<string | Uint8Array>>): HistorySearchSource {
  return {
    listSessions: async () => Object.keys(sessions),
    async *read(sessionId) {
      let timestamp = 1000;
      for (const data of sessions[sessionId] ?? [])
        yield { timestamp: timestamp++, data: typeof data === "string" ? encoder.encode(data) : data };
    },
  };
}

describe("AnsiStripper", () => {
  const strip = (...chunks: string[]): string => {
    const stripper = new AnsiStripper();
    return chunks.map((chunk) => stripper.push(chunk)).join("");
  };

  it("removes CSI, OSC, DCS and two-character sequences and keeps the text", () => {
    expect(strip("\x1b[1;31mred\x1b[0m plain")).toBe("red plain");
    expect(strip("a\x1b]0;window title\x07b")).toBe("ab");
    expect(strip("a\x1b]8;;https://example.invalid\x1b\\link\x1b]8;;\x1b\\b")).toBe("alinkb");
    expect(strip("a\x1bPq#0;2;0;0;0\x1b\\b")).toBe("ab");
    expect(strip("a\x1b7b\x1b(0c\x1bcd")).toBe("abcd");
    expect(strip("a\x9b31mb\x9d0;t\x9cc")).toBe("abc");
  });

  it("keeps line breaks and tabs, drops other control characters", () => {
    expect(strip("a\tb\r\nc\x07d\x08e\x7ff")).toBe("a\tb\r\ncdef");
  });

  it("follows a sequence across chunk boundaries", () => {
    expect(strip("a\x1b", "[3", "1mb")).toBe("ab");
    expect(strip("a\x1b]0;ti", "tle\x1b", "\\b")).toBe("ab");
    expect(strip("a\x1b", "(", "0b")).toBe("ab");
  });

  it("does not swallow text after an aborted or unterminated sequence", () => {
    expect(strip("a\x1b[31\x1b[0mb")).toBe("ab");
    expect(strip("a\x1b]0;t\x1b[0mb")).toBe("ab");
    const long = "x".repeat(10_000);
    expect(strip(`\x1b]0;${long}`).length).toBeGreaterThan(5000);
    expect(strip(`\x1b[${"1".repeat(10_000)}`).length).toBeGreaterThan(5000);
  });
});

describe("searchHistory", () => {
  it("finds a case-insensitive plain-text match with session, timestamp, line and offset", async () => {
    const source = memorySource({ s1: ["first\r\n", "Build ERROR in file\r\n"], s2: ["nothing\r\n"] });

    const result = await searchHistory(source, { query: "error" });

    expect(result).toEqual({
      hits: [{ sessionId: "s1", timestamp: 1001, line: "Build ERROR in file", offset: 6 }],
      truncated: false,
    });
  });

  it("treats the query as text, not as a pattern", async () => {
    const source = memorySource({ s1: ["a.c matches\r\n", "abc does not\r\n", "(x)+ [y]\r\n"] });

    expect((await searchHistory(source, { query: "a.c" })).hits.map((hit) => hit.line)).toEqual([
      "a.c matches",
    ]);
    expect((await searchHistory(source, { query: "(x)+ [y]" })).hits).toHaveLength(1);
    expect((await searchHistory(source, { query: ".*" })).hits).toHaveLength(0);
  });

  it("finds hits of two sessions, newest first, and restricts to the given sessions", async () => {
    const source = memorySource({ s1: ["todo one\r\n", "x\r\n"], s2: ["x\r\n", "x\r\n", "todo two\r\n"] });

    const all = await searchHistory(source, { query: "todo" });
    expect(all.hits.map((hit) => [hit.sessionId, hit.line])).toEqual([
      ["s2", "todo two"],
      ["s1", "todo one"],
    ]);

    const only = await searchHistory(source, { query: "todo", sessionIds: ["s1"] });
    expect(only.hits.map((hit) => hit.sessionId)).toEqual(["s1"]);
  });

  it("finds a line that spans entries and an escape sequence that spans entries", async () => {
    const source = memorySource({
      s1: ["hello wor", "ld\r\n", "pro\x1b[3", "1mpper\x1b[0m done\r\n"],
    });

    const hits = (await searchHistory(source, { query: "world" })).hits;
    expect(hits.map((hit) => hit.line)).toEqual(["hello world"]);
    expect((await searchHistory(source, { query: "propper done" })).hits).toHaveLength(1);
  });

  it("does not match the escape sequences themselves and shows the text without them", async () => {
    const source = memorySource({ s1: ["\x1b[31mred text\x1b[0m\r\n", "\x1b]0;secret title\x07ok\r\n"] });

    expect((await searchHistory(source, { query: "[31m" })).hits).toHaveLength(0);
    expect((await searchHistory(source, { query: "secret" })).hits).toHaveLength(0);
    const hits = (await searchHistory(source, { query: "text" })).hits;
    expect(hits[0]).toMatchObject({ line: "red text", offset: 4 });
  });

  it("treats carriage returns as line ends and decodes UTF-8 split across entries", async () => {
    const bytes = encoder.encode("grüße\r\n");
    const source = memorySource({
      s1: ["progress 10%\rprogress 20%\r", bytes.subarray(0, 3), bytes.subarray(3)],
    });

    expect((await searchHistory(source, { query: "progress" })).hits.map((hit) => hit.line)).toEqual([
      "progress 20%",
      "progress 10%",
    ]);
    expect((await searchHistory(source, { query: "grüße" })).hits).toHaveLength(1);
  });

  it("includes the last line without a line break", async () => {
    const source = memorySource({ s1: ["done\r\n", "prompt$ ls"] });

    expect((await searchHistory(source, { query: "prompt" })).hits[0]?.line).toBe("prompt$ ls");
  });

  it("cuts a long line around the match", async () => {
    const line = `${"a".repeat(1000)}NEEDLE${"b".repeat(1000)}`;
    const source = memorySource({ s1: [`${line}\r\n`] });

    const [hit] = (await searchHistory(source, { query: "needle" })).hits;
    expect(hit!.line.length).toBe(MAX_HISTORY_LINE_LENGTH);
    expect(hit!.line.slice(hit!.offset, hit!.offset + 6)).toBe("NEEDLE");
  });

  it("finds a match inside a line longer than the read buffer, also across its cut", async () => {
    const prefix = "a".repeat(MAX_SEARCH_LINE_BUFFER - 3);
    const source = memorySource({ s1: [`${prefix}NEEDLE${"b".repeat(10_000)}\r\n`] });

    const [hit] = (await searchHistory(source, { query: "needle" })).hits;
    expect(hit).toBeDefined();
    expect(hit!.line.slice(hit!.offset, hit!.offset + 6)).toBe("NEEDLE");
    expect((await searchHistory(source, { query: "needle" })).hits).toHaveLength(1);
  });

  it("limits the hits to `limit`, keeps the newest and reports truncated", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `hit ${i}\r\n`);
    const source = memorySource({ s1: lines });

    const result = await searchHistory(source, { query: "hit", limit: 3 });

    expect(result.hits.map((hit) => hit.line)).toEqual(["hit 9", "hit 8", "hit 7"]);
    expect(result.truncated).toBe(true);
    const exact = await searchHistory(source, { query: "hit", limit: 10 });
    expect(exact.hits).toHaveLength(10);
    expect(exact.truncated).toBe(false);
  });

  it("never returns more than MAX_HISTORY_HITS, however many lines match", async () => {
    const source = memorySource({ s1: Array.from({ length: 500 }, (_, i) => `match ${i}\r\n`) });

    const result = await searchHistory(source, { query: "match", limit: 100_000 });

    expect(result.hits).toHaveLength(MAX_HISTORY_HITS);
    expect(result.hits[0]?.line).toBe("match 499");
    expect(result.truncated).toBe(true);
  });

  it("ends at the time limit with the partial result and truncated", async () => {
    let now = 0;
    const source: HistorySearchSource = {
      listSessions: async () => ["s1", "s2"],
      async *read(sessionId) {
        for (let i = 0; i < 3; i++) {
          now += 100;
          yield { timestamp: i, data: encoder.encode(`${sessionId} match ${i}\r\n`) };
        }
      },
    };

    const result = await searchHistory(source, { query: "match", maxMs: 250, now: () => now });

    expect(result.truncated).toBe(true);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.length).toBeLessThan(6);
    expect(result.hits.every((hit) => hit.sessionId === "s1")).toBe(true);
  });

  it("skips sessions it may not look at and ids that are no safe path", async () => {
    const source = memorySource({ s1: ["x here\r\n"], orphan: ["x here\r\n"], "../evil": ["x here\r\n"] });

    const result = await searchHistory(source, {
      query: "x",
      sessionIds: ["s1", "orphan", "../evil"],
      isKnownSession: (id) => id !== "orphan",
    });

    expect(result.hits.map((hit) => hit.sessionId)).toEqual(["s1"]);
  });

  it("finds nothing for a query with a line break", async () => {
    const source = memorySource({ s1: ["a\r\nb\r\n"] });

    expect(await searchHistory(source, { query: "a\nb" })).toEqual({ hits: [], truncated: false });
  });
});

describe("searchHistory over a HistoryStore", () => {
  it("finds hits of two sessions in both segments across a rotation", async () => {
    const store = makeStore(tempDir());
    // 64 KiB limit: segments of 32 KiB; 100 entries of 1000 bytes rotate at least once.
    for (let i = 0; i < 100; i++) {
      store.append("s1", encoder.encode(`marker ${i} ${"#".repeat(980)}\r\n`));
      if (i % 25 === 0) store.append("s2", encoder.encode(`marker other ${i}\r\n`));
    }
    await store.flush();

    const result = await searchHistory(storeSource(store), { query: "marker", limit: 200 });

    const s1 = result.hits.filter((hit) => hit.sessionId === "s1").map((hit) => hit.line.slice(0, 11));
    expect(result.hits.filter((hit) => hit.sessionId === "s2")).toHaveLength(4);
    // The oldest output is gone (ring buffer); what is left is gapless up to the newest line.
    expect(s1.length).toBeGreaterThan(32);
    expect(s1.length).toBeLessThan(100);
    expect(s1[0]).toBe("marker 99 #");
    const numbers = s1.map((line) => Number(/marker (\d+)/.exec(line)![1]));
    expect(numbers).toEqual(numbers.map((_, index) => 99 - index));
    expect(result.truncated).toBe(false);
  });

  it("finds output that is queued but not written yet", async () => {
    const store = makeStore(tempDir());
    store.append("s1", encoder.encode("fresh output\r\n"));

    const result = await searchHistory(storeSource(store), { query: "fresh" });

    expect(result.hits).toHaveLength(1);
  });

  it("is not disturbed by output and a segment change that arrive during the search", async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    for (let i = 0; i < 30; i++) store.append("s1", encoder.encode(`old ${i} ${"#".repeat(980)}\r\n`));
    await store.flush();

    let flushed: Promise<void> | undefined;
    const source: HistorySearchSource = {
      listSessions: () => store.listSessions(),
      async *read(sessionId) {
        let first = true;
        for await (const entry of store.read(sessionId)) {
          yield entry;
          if (first) {
            first = false;
            // 80 KiB more: enough for a rotation that would move the bytes under an unlocked reader.
            for (let i = 0; i < 80; i++)
              store.append("s1", encoder.encode(`new ${i} ${"#".repeat(980)}\r\n`));
            flushed = store.flush();
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
      },
    };

    const result = await searchHistory(source, { query: "old ", limit: 200 });
    await flushed;

    // Exactly what was stored before the search began; every line complete, none twice.
    expect(result.hits).toHaveLength(30);
    expect(new Set(result.hits.map((hit) => hit.line)).size).toBe(30);
    expect(result.hits.every((hit) => /^old \d+ #+$/.test(hit.line))).toBe(true);
    // The writer went on afterwards.
    const after = await searchHistory(storeSource(store), { query: "new 79" });
    expect(after.hits).toHaveLength(1);
  });

  it("finds nothing of a deleted session, also when it is deleted during the search", async () => {
    const store = makeStore(tempDir());
    store.append("s1", encoder.encode("keep me\r\n"));
    store.append("s2", encoder.encode("keep me too\r\n"));
    await store.flush();

    let removed: Promise<void> | undefined;
    const source: HistorySearchSource = {
      listSessions: () => store.listSessions(),
      read: (sessionId) => {
        if (sessionId === "s1") removed = store.remove("s2");
        return store.read(sessionId);
      },
    };
    const during = await searchHistory(source, { query: "keep" });
    await removed;

    expect(during.hits.map((hit) => hit.sessionId)).toContain("s1");
    const after = await searchHistory(storeSource(store), { query: "keep" });
    expect(after.hits.map((hit) => hit.sessionId)).toEqual(["s1"]);
    expect(await store.listSessions()).toEqual(["s1"]);
    expect(await searchHistory(storeSource(store), { query: "keep", sessionIds: ["s2"] })).toEqual({
      hits: [],
      truncated: false,
    });
  });

  it("finds nothing for a session without history and for a store without any", async () => {
    const store = makeStore(tempDir());

    expect(await searchHistory(storeSource(store), { query: "x" })).toEqual({ hits: [], truncated: false });
    expect(await searchHistory(storeSource(store), { query: "x", sessionIds: ["none"] })).toEqual({
      hits: [],
      truncated: false,
    });
  });
});
