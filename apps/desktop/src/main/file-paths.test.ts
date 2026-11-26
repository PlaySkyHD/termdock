import { describe, expect, it } from "vitest";
import type { FileLocation } from "../shared/files.js";
import {
  checkDialogPath,
  checkLocation,
  checkWindowsPath,
  checkWslPath,
  childOf,
  isInside,
  isProgramName,
  isProtected,
  isRoot,
  isValidDistroName,
  pathExtensions,
  isValidEntryName,
  nameOf,
  parentOf,
  toFsPath,
} from "./file-paths.js";

describe("checkWslPath", () => {
  it("accepts an absolute path and normalizes it", () => {
    expect(checkWslPath("/home/dev/./src//x")).toBe("/home/dev/src/x");
    expect(checkWslPath("/")).toBe("/");
    expect(checkWslPath("/ä ö/ü")).toBe("/ä ö/ü");
  });

  it.each([
    ["relative", "home/dev"],
    ["empty", ""],
    ["parent segment", "/home/../etc"],
    ["leading parent", "/../etc"],
    ["control character", "/home/a\nb"],
    ["NUL", "/home/a\u0000b"],
    ["DEL", "/home/a\u007fb"],
    ["backslash", "/home\\dev"],
    ["too long", `/${"p".repeat(512)}`],
  ])("rejects %s", (_name, value) => {
    expect(checkWslPath(value)).toBeUndefined();
  });

  it("rejects a value that is no string", () => {
    expect(checkWslPath(undefined)).toBeUndefined();
    expect(checkWslPath(5)).toBeUndefined();
  });

  it("accepts the longest path", () => {
    expect(checkWslPath(`/${"p".repeat(511)}`)).toBeDefined();
  });
});

describe("checkWindowsPath", () => {
  it("accepts a drive path with either separator and normalizes it", () => {
    expect(checkWindowsPath("C:/Users/dev//x")).toBe("C:\\Users\\dev\\x");
    expect(checkWindowsPath("p:\\GitHub\\.\\termdock")).toBe("p:\\GitHub\\termdock");
    expect(checkWindowsPath("C:\\")).toBe("C:\\");
  });

  it.each([
    ["UNC", "\\\\server\\share\\x"],
    ["UNC with slashes", "//server/share/x"],
    ["wsl UNC", "\\\\wsl.localhost\\Ubuntu\\tmp"],
    ["device path", "\\\\?\\C:\\x"],
    ["relative", "x\\y"],
    ["drive relative", "C:x"],
    ["rooted without drive", "\\x"],
    ["parent segment", "C:\\a\\..\\b"],
    ["alternate data stream", "C:\\a\\b.txt:stream"],
    ["wildcard", "C:\\a\\*"],
    ["control character", "C:\\a\tb"],
    ["device name", "C:\\a\\NUL"],
    ["device name with extension", "C:\\a\\con.txt"],
    ["too long", `C:\\${"p".repeat(510)}`],
  ])("rejects %s", (_name, value) => {
    expect(checkWindowsPath(value)).toBeUndefined();
  });
});

describe("checkLocation", () => {
  it("normalizes a wsl and a windows location", () => {
    expect(checkLocation({ backend: "wsl", distro: "Ubuntu", path: "/a/./b" })).toEqual({
      backend: "wsl",
      distro: "Ubuntu",
      path: "/a/b",
    });
    expect(checkLocation({ backend: "windows", path: "C:/a" })).toEqual({
      backend: "windows",
      path: "C:\\a",
    });
  });

  it("rejects distro names that are no distro names", () => {
    for (const distro of ["", "..", "a/b", "a\\b", "-x", "Ubuntu 22", "a".repeat(65)]) {
      expect(isValidDistroName(distro), distro).toBe(false);
      expect(checkLocation({ backend: "wsl", distro, path: "/" }), distro).toBeUndefined();
    }
    expect(isValidDistroName("Ubuntu-24.04")).toBe(true);
  });

  it("rejects a distro the core does not know", () => {
    expect(checkLocation({ backend: "wsl", distro: "Debian", path: "/" }, ["Ubuntu"])).toBeUndefined();
    expect(checkLocation({ backend: "wsl", distro: "Ubuntu", path: "/" }, ["Ubuntu"])).toBeDefined();
  });
});

describe("toFsPath", () => {
  it("translates a wsl path to the UNC path of the distro", () => {
    expect(toFsPath({ backend: "wsl", distro: "Ubuntu", path: "/home/dev/a b" })).toBe(
      "\\\\wsl.localhost\\Ubuntu\\home\\dev\\a b",
    );
    expect(toFsPath({ backend: "wsl", distro: "Ubuntu", path: "/" })).toBe("\\\\wsl.localhost\\Ubuntu\\");
  });

  it("keeps a windows path and honors another root", () => {
    expect(toFsPath({ backend: "windows", path: "C:\\a" })).toBe("C:\\a");
    expect(toFsPath({ backend: "wsl", distro: "d", path: "/x" }, (distro) => `C:\\t\\${distro}`)).toBe(
      "C:\\t\\d\\x",
    );
  });
});

describe("locations", () => {
  const wsl = (path: string) => ({ backend: "wsl" as const, distro: "Ubuntu", path });
  const win = (path: string) => ({ backend: "windows" as const, path });

  it("knows roots, parents, children and names", () => {
    expect(isRoot(wsl("/"))).toBe(true);
    expect(isRoot(wsl("/a"))).toBe(false);
    expect(isRoot(win("C:\\"))).toBe(true);
    expect(isRoot(win("C:\\a"))).toBe(false);
    expect(parentOf(wsl("/a/b"))).toEqual(wsl("/a"));
    expect(parentOf(wsl("/a"))).toEqual(wsl("/"));
    expect(parentOf(wsl("/"))).toBeUndefined();
    expect(parentOf(win("C:\\a\\b"))).toEqual(win("C:\\a"));
    expect(parentOf(win("C:\\"))).toBeUndefined();
    expect(childOf(wsl("/a"), "b")).toEqual(wsl("/a/b"));
    expect(childOf(win("C:\\"), "b")).toEqual(win("C:\\b"));
    expect(nameOf(wsl("/a/b"))).toBe("b");
    expect(nameOf(win("C:\\a\\b"))).toBe("b");
  });

  it("tells whether a location lies inside another", () => {
    expect(isInside(wsl("/a"), wsl("/a"))).toBe(true);
    expect(isInside(wsl("/a"), wsl("/a/b"))).toBe(true);
    expect(isInside(wsl("/a"), wsl("/ab"))).toBe(false);
    expect(isInside(wsl("/"), wsl("/a"))).toBe(true);
    expect(isInside(wsl("/a"), { ...wsl("/a/b"), distro: "Debian" })).toBe(false);
    expect(isInside(win("C:\\A"), win("c:\\a\\b"))).toBe(true);
    expect(isInside(win("C:\\a"), win("C:\\ab"))).toBe(false);
    expect(isInside(win("C:\\a"), wsl("/a"))).toBe(false);
  });
});

describe("isValidEntryName", () => {
  it("accepts one plain name", () => {
    expect(isValidEntryName("notes.txt", "wsl")).toBe(true);
    expect(isValidEntryName("a b", "windows")).toBe(true);
    expect(isValidEntryName("a:b", "wsl")).toBe(true);
  });

  it.each(["", ".", "..", "a/b", "a\\b", "a\nb", "a".repeat(256), "ä".repeat(128)])("rejects %j", (name) => {
    expect(isValidEntryName(name, "wsl")).toBe(false);
  });

  it("adds the Windows restrictions only for windows", () => {
    for (const name of ["a:b", "a*", "a?", "nul", "con.txt", "a.", "a "]) {
      expect(isValidEntryName(name, "windows"), name).toBe(false);
    }
    expect(isValidEntryName("a*", "wsl")).toBe(true);
    expect(isValidEntryName(5, "wsl")).toBe(false);
  });
});

describe("isProtected", () => {
  const wsl = (p: string): FileLocation => ({ backend: "wsl", distro: "Ubuntu", path: p });

  it("protects the roots, the folders under /, the drives of /mnt and /mnt/wsl/*", () => {
    for (const p of [
      "/",
      "/home",
      "/usr",
      "/mnt",
      "/proc",
      "/etc",
      "/mnt/c",
      "/mnt/d",
      "/mnt/wsl",
      "/mnt/wsl/x",
    ]) {
      expect(isProtected(wsl(p)), p).toBe(true);
    }
    expect(isProtected({ backend: "windows", path: "C:\\" })).toBe(true);
  });

  it("leaves everything below alone", () => {
    for (const p of ["/home/dev", "/mnt/c/Users", "/mnt/wsl/x/y", "/tmp/a", "/mnt/c/Users/dev/a.txt"]) {
      expect(isProtected(wsl(p)), p).toBe(false);
    }
    expect(isProtected({ backend: "windows", path: "C:\\Users" })).toBe(false);
  });
});

describe("pathExtensions", () => {
  it("reads a PATHEXT value in lower case and drops what is no extension", () => {
    expect(pathExtensions(".COM;.EXE; .Foo ;;junk;.a.b;.x\\y")).toEqual([".com", ".exe", ".foo"]);
    expect(pathExtensions(undefined)).toEqual([]);
  });

  it("makes isProgramName refuse them", () => {
    expect(isProgramName("a.foo")).toBe(false);
    expect(isProgramName("a.foo", [".foo"])).toBe(true);
  });
});

describe("isProgramName", () => {
  it("flags the types of the review", () => {
    for (const name of [
      "a.pyz",
      "a.pyzw",
      "a.pyc",
      "a.pyo",
      "a.wsb",
      "a.appinstaller",
      "a.appx",
      "a.msix",
      "a.diagcab",
      "a.vb",
      "a.mde",
      "a.accde",
      "a.xll",
      "a.search-ms",
      "a.rdp",
      "a.settingcontent-ms",
      "a.library-ms",
      "a.url",
      "a.website",
    ]) {
      expect(isProgramName(name), name).toBe(true);
    }
  });

  it("flags what the system would run", () => {
    for (const name of ["a.exe", "a.BAT", "a.ps1", "a.lnk", "a.js", "a.sh"])
      expect(isProgramName(name), name).toBe(true);
    for (const name of ["a.txt", "a.md", "exe", ".gitignore", "a.exe.txt"])
      expect(isProgramName(name), name).toBe(false);
  });

  it("sees through trailing dots and spaces and flags more types", () => {
    for (const name of ["run.bat.", "x.cmd ", "x.cmd. .", "a.py", "a.msix", "a.dll", "a.settingcontent-ms"])
      expect(isProgramName(name), name).toBe(true);
  });
});

describe("checkDialogPath", () => {
  it("accepts what a native dialog returns, including a share", () => {
    expect(checkDialogPath("C:\\out\\a b.txt")).toBe("C:\\out\\a b.txt");
    expect(checkDialogPath("D:\\x \\y.")).toBe("D:\\x \\y.");
    expect(checkDialogPath("\\\\server\\share\\x")).toBe("\\\\server\\share\\x");
  });

  it.each([
    "",
    "out\\a",
    "C:a",
    "\\x",
    "\\\\?\\C:\\x",
    "\\\\.\\pipe\\x",
    "C:\\a\\..\\b",
    "C:\\a\nb",
    "C:\\a\u0000",
  ])("rejects %j", (value) => {
    expect(checkDialogPath(value)).toBeUndefined();
  });
});
