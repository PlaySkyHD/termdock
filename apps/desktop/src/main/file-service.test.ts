// The file service against a temporary folder. A WSL location is mapped into it (`wslRoot`), so both backends run
// through the same code as in the app. With TERMDOCK_WSL_TESTS=1 one test also reaches the real `\\wsl.localhost`.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_LIST_ENTRIES } from "../shared/files.js";
import type { FileLocation } from "../shared/files.js";
import { codeOf, FileService } from "./file-service.js";
import type { FileServiceDeps } from "./file-service.js";

let root = "";
let logs: string[] = [];
let dialogAnswers: { file?: string; folder?: string };
let shellCalls: string[] = [];
let openAnswer = "";
let distros: string[] = ["Ubuntu"];
let distroLookups = 0;

const wsl = (p: string): FileLocation => ({ backend: "wsl", distro: "Ubuntu", path: p });
const win = (p: string): FileLocation => ({ backend: "windows", path: p });
/** The Windows path of a name inside the WSL side of the temp folder, and of the Windows side. */
const wslSide = (...parts: string[]): string => path.join(root, "wsl", "Ubuntu", ...parts);
const winSide = (...parts: string[]): string => path.join(root, "win", ...parts);

function service(overrides: Partial<FileServiceDeps> = {}): FileService {
  return new FileService({
    distros: async () => {
      distroLookups += 1;
      return distros;
    },
    dialogs: {
      saveFile: async () => dialogAnswers.file,
      chooseFolder: async () => dialogAnswers.folder,
    },
    shell: {
      showItemInFolder: (target) => void shellCalls.push(`reveal ${target}`),
      openPath: async (target) => {
        shellCalls.push(`open ${target}`);
        return openAnswer;
      },
    },
    wslRoot: (distro) => path.join(root, "wsl", distro),
    log: (line) => void logs.push(line),
    ...overrides,
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "termdock-files-"));
  mkdirSync(wslSide(), { recursive: true });
  mkdirSync(winSide(), { recursive: true });
  logs = [];
  dialogAnswers = {};
  shellCalls = [];
  openAnswer = "";
  distros = ["Ubuntu"];
  distroLookups = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The WSL path `/a` that lives in the temp folder as `wslSide("a")`. */
const failure = (code: string) => ({ ok: false, code });

describe("list", () => {
  it("returns name, kind, size and time, folders first", async () => {
    mkdirSync(wslSide("zeta"));
    mkdirSync(wslSide("Alpha"));
    writeFileSync(wslSide("b.txt"), "12345");
    writeFileSync(wslSide("a.txt"), "");
    const result = await service().list(wsl("/"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      "directory:Alpha",
      "directory:zeta",
      "file:a.txt",
      "file:b.txt",
    ]);
    expect(result.entries[3]?.size).toBe(5);
    expect(result.entries[0]?.size).toBe(0);
    expect(Math.abs((result.entries[3]?.modified ?? 0) - Date.now())).toBeLessThan(60_000);
    expect(result).toMatchObject({ truncated: false, total: 4 });
  });

  it("lists a windows folder the same way", async () => {
    writeFileSync(winSide("x.txt"), "ab");
    const result = await service().list(win(winSide()));
    expect(result).toMatchObject({ ok: true, entries: [{ name: "x.txt", kind: "file", size: 2 }] });
  });

  it("marks symlinks with the kind of their target", async () => {
    mkdirSync(wslSide("dir"));
    writeFileSync(wslSide("file"), "x");
    try {
      symlinkSync(wslSide("dir"), wslSide("to-dir"), "junction");
      symlinkSync(wslSide("file"), wslSide("to-file"), "file");
      symlinkSync(wslSide("missing"), wslSide("dangling"), "file");
    } catch {
      return; // no right to create symlinks on this host
    }
    const result = await service().list(wsl("/"));
    if (!result.ok) throw new Error("list failed");
    const byName = Object.fromEntries(result.entries.map((entry) => [entry.name, entry]));
    expect(byName["to-file"]).toMatchObject({ kind: "symlink", targetKind: "file" });
    expect(byName["dangling"]).toMatchObject({ kind: "symlink" });
    expect(byName["dangling"]?.targetKind).toBeUndefined();
  });

  it("cuts a long folder at the limit and says so", async () => {
    const count = MAX_LIST_ENTRIES + 3;
    for (let i = 0; i < count; i += 1) writeFileSync(wslSide(`f${String(i).padStart(5, "0")}`), "");
    mkdirSync(wslSide("zzz-folder"));
    const result = await service().list(wsl("/"));
    if (!result.ok) throw new Error("list failed");
    expect(result.entries).toHaveLength(MAX_LIST_ENTRIES);
    expect(result).toMatchObject({ truncated: true, total: count + 1 });
    expect(result.entries[0]?.name).toBe("zzz-folder");
  }, 30_000);

  it("answers ENOENT for a missing folder and EINVAL for a file", async () => {
    writeFileSync(wslSide("f"), "");
    expect(await service().list(wsl("/missing"))).toEqual(failure("ENOENT"));
    expect(await service().list(wsl("/f"))).toEqual(failure("EINVAL"));
  });
});

describe("invalid locations", () => {
  it.each<[string, FileLocation]>([
    ["relative", wsl("a/b")],
    ["parent segment", wsl("/a/../b")],
    ["control character", wsl("/a\nb")],
    ["bad distro name", { backend: "wsl", distro: "../x", path: "/" }],
    ["unknown distro", { backend: "wsl", distro: "Debian", path: "/" }],
    ["UNC path", win("\\\\server\\share\\x")],
    ["relative windows", win("a\\b")],
    ["too long", wsl(`/${"p".repeat(512)}`)],
  ])("answers EINVAL for %s on every operation", async (_name, location) => {
    const files = service();
    const results = [
      await files.list(location),
      await files.rename(location, "x"),
      await files.move(location, wsl("/")),
      await files.delete(location),
      await files.download(1, location),
      await files.reveal(location),
      await files.open(location),
    ];
    for (const result of results) expect(result).toEqual(failure("EINVAL"));
    expect(shellCalls).toEqual([]);
  });

  it("does not touch the file system for a refused location", async () => {
    writeFileSync(wslSide("keep"), "x");
    await service().delete(wsl("/../keep"));
    expect(existsSync(wslSide("keep"))).toBe(true);
  });
});

describe("distros", () => {
  it("asks the core once and again only for an unknown name or after the cache expired", async () => {
    let now = 0;
    const files = service({ now: () => now });
    await files.list(wsl("/"));
    await files.list(wsl("/"));
    expect(distroLookups).toBe(1);
    distros = ["Ubuntu", "Debian"];
    const debian: FileLocation = { backend: "wsl", distro: "Debian", path: "/" };
    // An unknown name does not ask again within seconds, however often it comes.
    now = 1_000;
    for (let i = 0; i < 20; i += 1) expect(await files.list(debian)).toEqual(failure("EINVAL"));
    expect(distroLookups).toBe(1);
    now = 6_000;
    await files.list(debian);
    expect(distroLookups).toBe(2);
    now = 40_000;
    await files.list(wsl("/"));
    expect(distroLookups).toBe(3);
  });

  it("answers OTHER when the core cannot say", async () => {
    const files = service({
      distros: async () => {
        throw new Error("core gone");
      },
    });
    expect(await files.list(wsl("/"))).toEqual(failure("OTHER"));
    expect(logs).toEqual(["files.list: OTHER"]);
  });
});

describe("rename", () => {
  it("renames in place and returns the new location", async () => {
    writeFileSync(wslSide("a.txt"), "x");
    expect(await service().rename(wsl("/a.txt"), "b.txt")).toEqual({ ok: true, location: wsl("/b.txt") });
    expect(existsSync(wslSide("a.txt"))).toBe(false);
    expect(readFileSync(wslSide("b.txt"), "utf8")).toBe("x");
  });

  it("refuses a name with a separator or a path, and leaves the entry alone", async () => {
    writeFileSync(wslSide("a.txt"), "x");
    for (const name of ["", ".", "..", "x/y", "x\\y", "../b", "a\nb"]) {
      expect(await service().rename(wsl("/a.txt"), name), name).toEqual(failure("EINVAL"));
    }
    expect(existsSync(wslSide("a.txt"))).toBe(true);
  });

  it("answers EEXIST instead of replacing and ENOENT for a missing entry", async () => {
    writeFileSync(wslSide("a"), "A");
    writeFileSync(wslSide("b"), "B");
    expect(await service().rename(wsl("/a"), "b")).toEqual(failure("EEXIST"));
    expect(readFileSync(wslSide("b"), "utf8")).toBe("B");
    expect(await service().rename(wsl("/nope"), "c")).toEqual(failure("ENOENT"));
  });

  it("allows a rename that only changes the case, but not onto another entry", async () => {
    writeFileSync(winSide("readme.md"), "x");
    writeFileSync(winSide("other"), "y");
    expect(await service().rename(win(winSide("readme.md")), "Readme.md")).toEqual({
      ok: true,
      location: win(winSide("Readme.md")),
    });
    expect(readdirSync(winSide()).sort()).toEqual(["Readme.md", "other"]);
    expect(await service().rename(win(winSide("Readme.md")), "OTHER")).toEqual(failure("EEXIST"));
  });

  it("refuses to rename a root", async () => {
    expect(await service().rename(wsl("/"), "x")).toEqual(failure("EINVAL"));
  });

  it("applies the Windows name rules to a windows location only", async () => {
    writeFileSync(winSide("a"), "");
    writeFileSync(wslSide("a"), "");
    expect(await service().rename(win(winSide("a")), "b:c")).toEqual(failure("EINVAL"));
    // The name passes the check for WSL (the temp folder of this test is on Windows, so the rename itself may fail).
    expect(await service().rename(wsl("/a"), "b:c")).not.toEqual(failure("EINVAL"));
  });
});

describe("move", () => {
  it("moves a file and a folder with its content into another folder", async () => {
    mkdirSync(wslSide("target"));
    mkdirSync(wslSide("dir"));
    writeFileSync(wslSide("dir", "inner"), "i");
    writeFileSync(wslSide("f"), "f");
    expect(await service().move(wsl("/f"), wsl("/target"))).toEqual({ ok: true, location: wsl("/target/f") });
    expect(await service().move(wsl("/dir"), wsl("/target"))).toEqual({
      ok: true,
      location: wsl("/target/dir"),
    });
    expect(readFileSync(wslSide("target", "dir", "inner"), "utf8")).toBe("i");
    expect(existsSync(wslSide("f"))).toBe(false);
  });

  it("answers EEXIST and keeps both entries", async () => {
    mkdirSync(wslSide("target"));
    writeFileSync(wslSide("target", "f"), "old");
    writeFileSync(wslSide("f"), "new");
    expect(await service().move(wsl("/f"), wsl("/target"))).toEqual(failure("EEXIST"));
    expect(readFileSync(wslSide("target", "f"), "utf8")).toBe("old");
    expect(readFileSync(wslSide("f"), "utf8")).toBe("new");
  });

  it("refuses a folder into itself, a root and another backend", async () => {
    mkdirSync(wslSide("dir", "sub"), { recursive: true });
    writeFileSync(wslSide("f"), "");
    expect(await service().move(wsl("/dir"), wsl("/dir"))).toEqual(failure("EINVAL"));
    expect(await service().move(wsl("/dir"), wsl("/dir/sub"))).toEqual(failure("EINVAL"));
    expect(await service().move(wsl("/"), wsl("/dir"))).toEqual(failure("EINVAL"));
    expect(await service().move(wsl("/f"), win(winSide()))).toEqual(failure("EINVAL"));
    expect(existsSync(wslSide("f"))).toBe(true);
  });

  it("answers ENOENT for a missing target folder", async () => {
    writeFileSync(wslSide("f"), "");
    expect(await service().move(wsl("/f"), wsl("/missing"))).toEqual(failure("ENOENT"));
  });

  it("moves inside the windows backend", async () => {
    mkdirSync(winSide("t"));
    writeFileSync(winSide("f"), "w");
    expect(await service().move(win(winSide("f")), win(winSide("t")))).toEqual({
      ok: true,
      location: win(winSide("t", "f")),
    });
  });
});

describe("delete", () => {
  it("deletes a file and a folder recursively", async () => {
    mkdirSync(wslSide("dir", "sub"), { recursive: true });
    writeFileSync(wslSide("dir", "sub", "f"), "");
    writeFileSync(wslSide("g"), "");
    expect(await service().delete(wsl("/dir"))).toEqual({ ok: true });
    expect(await service().delete(wsl("/g"))).toEqual({ ok: true });
    expect(existsSync(wslSide("dir"))).toBe(false);
    expect(existsSync(wslSide("g"))).toBe(false);
  });

  it("answers ENOENT for a missing entry and refuses a root", async () => {
    expect(await service().delete(wsl("/nope"))).toEqual(failure("ENOENT"));
    expect(await service().delete(wsl("/"))).toEqual(failure("EINVAL"));
    expect(await service().delete(win("C:\\"))).toEqual(failure("EINVAL"));
    expect(existsSync(wslSide())).toBe(true);
  });

  it("deletes a symlink, not its target", async () => {
    mkdirSync(wslSide("dir"));
    writeFileSync(wslSide("dir", "f"), "");
    try {
      symlinkSync(wslSide("dir"), wslSide("link"), "junction");
    } catch {
      return;
    }
    expect(await service().delete(wsl("/link"))).toEqual({ ok: true });
    expect(existsSync(wslSide("dir", "f"))).toBe(true);
  });
});

describe("download", () => {
  it("copies a file to the path of the save dialog", async () => {
    writeFileSync(wslSide("a.txt"), "content");
    dialogAnswers.file = winSide("saved.txt");
    expect(await service().download(1, wsl("/a.txt"))).toEqual({ ok: true, cancelled: false, skipped: 0 });
    expect(readFileSync(winSide("saved.txt"), "utf8")).toBe("content");
    expect(existsSync(wslSide("a.txt"))).toBe(true);
  });

  it("copies a folder recursively into the chosen folder, skipping symlinks inside", async () => {
    mkdirSync(wslSide("dir", "sub"), { recursive: true });
    writeFileSync(wslSide("dir", "sub", "f"), "deep");
    writeFileSync(wslSide("dir", "top"), "top");
    let links = 0;
    try {
      symlinkSync(wslSide("dir"), wslSide("dir", "loop"), "junction");
      links = 1;
    } catch {
      /* no right to create symlinks: the rest still holds */
    }
    mkdirSync(winSide("out"));
    dialogAnswers.folder = winSide("out");
    expect(await service().download(1, wsl("/dir"))).toEqual({ ok: true, cancelled: false, skipped: links });
    expect(readFileSync(winSide("out", "dir", "sub", "f"), "utf8")).toBe("deep");
    expect(readFileSync(winSide("out", "dir", "top"), "utf8")).toBe("top");
    expect(existsSync(winSide("out", "dir", "loop"))).toBe(false);
  });

  it("does nothing when the user cancels", async () => {
    writeFileSync(wslSide("a.txt"), "x");
    mkdirSync(wslSide("dir"));
    expect(await service().download(1, wsl("/a.txt"))).toEqual({ ok: true, cancelled: true, skipped: 0 });
    expect(await service().download(1, wsl("/dir"))).toEqual({ ok: true, cancelled: true, skipped: 0 });
  });

  it("skips and counts entries whose name Windows cannot hold", async () => {
    mkdirSync(wslSide("dir"));
    writeFileSync(wslSide("dir", "ok"), "ok");
    // A name with a trailing dot cannot be made through the Win32 name rules; the extended path form can.
    const odd = `\\\\?\\${wslSide("dir", "odd.")}`;
    try {
      writeFileSync(odd, "odd");
    } catch {
      return; // the host does not allow it; the name check itself is covered in file-paths.test.ts
    }
    mkdirSync(winSide("out"));
    dialogAnswers.folder = winSide("out");
    expect(await service().download(1, wsl("/dir"))).toEqual({ ok: true, cancelled: false, skipped: 1 });
    expect(readFileSync(winSide("out", "dir", "ok"), "utf8")).toBe("ok");
    expect(readdirSync(winSide("out", "dir"))).toEqual(["ok"]);
  });

  it("refuses an extended-length or device path from the dialog", async () => {
    writeFileSync(wslSide("a.txt"), "x");
    dialogAnswers.file = "\\\\?\\C:\\x";
    expect(await service().download(1, wsl("/a.txt"))).toEqual(failure("EINVAL"));
  });

  it("answers EEXIST for a folder that is already there and keeps it", async () => {
    mkdirSync(wslSide("dir"));
    writeFileSync(wslSide("dir", "f"), "new");
    mkdirSync(winSide("out", "dir"), { recursive: true });
    writeFileSync(winSide("out", "dir", "old"), "old");
    dialogAnswers.folder = winSide("out");
    expect(await service().download(1, wsl("/dir"))).toEqual(failure("EEXIST"));
    expect(existsSync(winSide("out", "dir", "f"))).toBe(false);
  });

  it("takes only WSL sources and only checked dialog answers", async () => {
    writeFileSync(winSide("w.txt"), "");
    writeFileSync(wslSide("a.txt"), "");
    expect(await service().download(1, win(winSide("w.txt")))).toEqual(failure("EINVAL"));
    expect(await service().download(1, wsl("/"))).toEqual(failure("EINVAL"));
    dialogAnswers.file = "relative\\x";
    expect(await service().download(1, wsl("/a.txt"))).toEqual(failure("EINVAL"));
  });

  it("answers ENOENT for a missing source", async () => {
    expect(await service().download(1, wsl("/nope"))).toEqual(failure("ENOENT"));
  });
});

describe("reveal and open", () => {
  it("hands the UNC path to the shell", async () => {
    writeFileSync(wslSide("a.txt"), "");
    expect(await service().reveal(wsl("/a.txt"))).toEqual({ ok: true });
    expect(await service().open(wsl("/a.txt"))).toEqual({ ok: true });
    expect(shellCalls).toEqual([`reveal ${wslSide("a.txt")}`, `open ${wslSide("a.txt")}`]);
  });

  it("opens a folder, but never a program or script", async () => {
    mkdirSync(wslSide("dir"));
    writeFileSync(wslSide("tool.exe"), "");
    writeFileSync(wslSide("run.bat"), "");
    expect(await service().open(wsl("/dir"))).toEqual({ ok: true });
    expect(await service().open(wsl("/tool.exe"))).toEqual(failure("EINVAL"));
    expect(await service().open(wsl("/run.bat"))).toEqual(failure("EINVAL"));
    expect(shellCalls).toEqual([`open ${wslSide("dir")}`]);
  });

  it("answers ENOENT without calling the shell for a missing entry", async () => {
    expect(await service().reveal(wsl("/nope"))).toEqual(failure("ENOENT"));
    expect(await service().open(wsl("/nope"))).toEqual(failure("ENOENT"));
    expect(shellCalls).toEqual([]);
  });

  it("does not pass on the error text of the shell", async () => {
    writeFileSync(wslSide("a.txt"), "");
    openAnswer = `Failed to open ${wslSide("a.txt")}`;
    const result = await service().open(wsl("/a.txt"));
    expect(result).toEqual(failure("OTHER"));
    expect(JSON.stringify(result)).not.toContain("a.txt");
  });
});

describe("errors", () => {
  it("maps fs codes to the codes of the contract", () => {
    expect(codeOf({ code: "ENOENT" })).toBe("ENOENT");
    expect(codeOf({ code: "EPERM" })).toBe("EACCES");
    expect(codeOf({ code: "EACCES" })).toBe("EACCES");
    expect(codeOf({ code: "ENOTEMPTY" })).toBe("EEXIST");
    expect(codeOf({ code: "ENOTDIR" })).toBe("EINVAL");
    expect(codeOf({ code: "EIO" })).toBe("OTHER");
    expect(codeOf(new Error("x"))).toBe("OTHER");
    expect(codeOf(undefined)).toBe("OTHER");
  });

  it("logs the operation and the code, never a path or an OS message", async () => {
    const secret = "td-secret-folder";
    await service().list(wsl(`/${secret}`));
    await service().delete(wsl(`/${secret}`));
    await service().rename(wsl("/a"), `bad/${secret}`);
    expect(logs).toEqual(["files.list: ENOENT", "files.delete: ENOENT", "files.rename: EINVAL"]);
    expect(logs.join("")).not.toContain(secret);
  });
});

// Reaches the real `\\wsl.localhost` (ADR 0009). Local only: GitHub runners have no distro.
describe.skipIf(process.env["TERMDOCK_WSL_TESTS"] !== "1")("real WSL (TERMDOCK_WSL_TESTS=1)", () => {
  it("lists /tmp, writes, renames, moves and deletes through the UNC path", async () => {
    const files = new FileService({
      distros: async () => ["Ubuntu"],
      dialogs: { saveFile: async () => undefined, chooseFolder: async () => undefined },
      shell: { showItemInFolder: () => {}, openPath: async () => "" },
    });
    const base = `/tmp/termdock-files-test-${process.pid}-${Date.now()}`;
    const unc = `\\\\wsl.localhost\\Ubuntu${base.replaceAll("/", "\\")}`;
    mkdirSync(unc, { recursive: true });
    try {
      writeFileSync(`${unc}\\a.txt`, "hello");
      mkdirSync(`${unc}\\sub`);
      const listed = await files.list(wsl(base));
      expect(listed).toMatchObject({ ok: true, total: 2 });
      expect(await files.rename(wsl(`${base}/a.txt`), "b.txt")).toMatchObject({ ok: true });
      expect(await files.move(wsl(`${base}/b.txt`), wsl(`${base}/sub`))).toMatchObject({ ok: true });
      expect(readFileSync(`${unc}\\sub\\b.txt`, "utf8")).toBe("hello");
      expect(await files.delete(wsl(base))).toEqual({ ok: true });
      expect(existsSync(unc)).toBe(false);
    } finally {
      rmSync(unc, { recursive: true, force: true });
    }
  }, 30_000);
});
