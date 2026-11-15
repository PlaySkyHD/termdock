import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Finds the image name of every `capture(...)` call. The name is the first string argument, so a
 * window before it (`capture(win, "12-x.png")`) works as well. Names with a number prefix are
 * scenes. Plain names without one (`failed-keymap.png`, diagnostics of a failed run) are ignored on
 * purpose: they are not part of the numbered sequence. A name built with a template (`${}`) cannot
 * be checked and is returned as `unchecked`: the test fails on it instead of ignoring it, because
 * a silent gap would defeat the uniqueness check.
 */
export function extractSceneNames(source: string): { names: string[]; unchecked: string[] } {
  const names: string[] = [];
  const unchecked: string[] = [];
  const call = /\bcapture\(\s*(?:[^"'`,()]+,\s*)?(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g;
  for (const match of source.matchAll(call)) {
    const name = match[2] ?? "";
    if (/^\d{2}[a-z]?-[^$]*\.png$/.test(name)) names.push(name);
    else if ((match[1] === "`" && name.includes("${")) || /^\d/.test(name)) unchecked.push(name);
  }
  const calls = source.match(/\bcapture\(/g)?.length ?? 0;
  const parsed = [...source.matchAll(call)].length;
  for (let i = parsed; i < calls; i++) unchecked.push("<capture call without a literal name>");
  return { names, unchecked };
}

/** `06a-x.png` belongs to the group `06`; letter suffixes only split scenes within a group. */
export function scenePrefix(name: string): string {
  return /^\d{2}/.exec(name)?.[0] ?? name;
}

/** Messages for duplicate names and for prefixes used by more than one file. */
export function prefixConflicts(files: Record<string, string[]>): string[] {
  const owners = new Map<string, Set<string>>();
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const [file, names] of Object.entries(files)) {
    for (const name of names) {
      const earlier = seen.get(name);
      if (earlier !== undefined) problems.push(`"${name}" kommt doppelt vor (${earlier}, ${file})`);
      else seen.set(name, file);
      const prefix = scenePrefix(name);
      const set = owners.get(prefix) ?? new Set<string>();
      set.add(file);
      owners.set(prefix, set);
    }
  }
  for (const [prefix, set] of owners) {
    if (set.size > 1) problems.push(`Präfix ${prefix} steht in ${[...set].join(" und ")}`);
  }
  return problems;
}

describe("extractSceneNames", () => {
  it("reads names of plain capture calls", () => {
    const source = `await capture("01-a.png");\n  await capture('06b-x-y.png');`;
    expect(extractSceneNames(source)).toEqual({ names: ["01-a.png", "06b-x-y.png"], unchecked: [] });
  });

  it("reads the name after a window argument and across lines", () => {
    const source = `await capture(win2, "17-restored.png");\nawait capture(\n  other.win,\n  "18-b.png",\n);`;
    expect(extractSceneNames(source).names).toEqual(["17-restored.png", "18-b.png"]);
  });

  it("reports template names and ignores unnumbered diagnostics", () => {
    const source = 'await capture(`${n}-x.png`);\nawait capture("plain.png");';
    expect(extractSceneNames(source)).toEqual({ names: [], unchecked: ["${n}-x.png"] });
  });

  it("reports malformed number prefixes and calls without a literal name", () => {
    const source = `await capture("3-x.png");\nawait capture(getWin(), "30-y.png");\nawait capture(name);`;
    expect(extractSceneNames(source).unchecked).toEqual([
      "3-x.png",
      "<capture call without a literal name>",
      "<capture call without a literal name>",
    ]);
  });

  it("ignores the helper definition and other calls", () => {
    const source = `const capture = async (name: string) => {};\nconst { capture } = driver;\nwin.webContents.capturePage();`;
    expect(extractSceneNames(source)).toEqual({ names: [], unchecked: [] });
  });
});

describe("prefixConflicts", () => {
  it("allows letter suffixes of one prefix within a file", () => {
    expect(prefixConflicts({ "a.ts": ["06a-x.png", "06b-y.png", "07-z.png"] })).toEqual([]);
  });

  it("names prefix and both files when two files share a prefix", () => {
    const problems = prefixConflicts({ "a.ts": ["30-x.png"], "b.ts": ["30-y.png", "31-z.png"] });
    expect(problems).toEqual(["Präfix 30 steht in a.ts und b.ts"]);
  });

  it("always rejects an identical name twice", () => {
    expect(prefixConflicts({ "a.ts": ["01-x.png", "01-x.png"] })).toEqual([
      '"01-x.png" kommt doppelt vor (a.ts, a.ts)',
    ]);
  });
});

describe("screenshot scenes", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir).filter((f) => /^screenshot-.*\.ts$/.test(f) && !f.endsWith(".test.ts"));

  it("finds the scene files", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it("has no scene name it cannot check", () => {
    for (const file of files) {
      expect({ file, unchecked: extractSceneNames(readFileSync(join(dir, file), "utf8")).unchecked }).toEqual(
        {
          file,
          unchecked: [],
        },
      );
    }
  });

  it("keeps every number prefix in a single file", () => {
    const byFile: Record<string, string[]> = {};
    for (const file of files) byFile[file] = extractSceneNames(readFileSync(join(dir, file), "utf8")).names;
    expect(prefixConflicts(byFile)).toEqual([]);
  });
});
