import { describe, expect, it } from "vitest";
import { MAX_CWD_LENGTH, parseCwdOsc, validCwd } from "./osc-cwd.js";

describe("parseCwdOsc (#200)", () => {
  it("reads the path with and without quotes", () => {
    expect(parseCwdOsc('9;"C:\\Windows"')).toEqual({ kind: "cwd", path: "C:\\Windows" });
    expect(parseCwdOsc("9;C:\\Program Files\\x")).toEqual({ kind: "cwd", path: "C:\\Program Files\\x" });
    expect(parseCwdOsc('9;"\\\\server\\share\\dir"')).toEqual({
      kind: "cwd",
      path: "\\\\server\\share\\dir",
    });
    expect(parseCwdOsc("9;D:/work")).toEqual({ kind: "cwd", path: "D:/work" });
  });

  it("keeps a semicolon inside the path", () => {
    expect(parseCwdOsc('9;"C:\\a;b"')).toEqual({ kind: "cwd", path: "C:\\a;b" });
  });

  it("drops a path with control characters, also in a quoted one", () => {
    for (const bad of ["C:\\a\u0000b", "C:\\a\u001bb", "C:\\a\nb", "C:\\a\u007fb", "C:\\a\u009bb"]) {
      expect(parseCwdOsc(`9;"${bad}"`)).toEqual({ kind: "invalid" });
      expect(parseCwdOsc(`9;${bad}`)).toEqual({ kind: "invalid" });
    }
  });

  it("drops a path that is too long, relative, a Linux path, empty or half quoted", () => {
    expect(parseCwdOsc(`9;"C:\\${"a".repeat(MAX_CWD_LENGTH)}"`)).toEqual({ kind: "invalid" });
    expect(parseCwdOsc(`9;"${`C:\\${"a".repeat(MAX_CWD_LENGTH - 3)}`}"`)).toMatchObject({ kind: "cwd" });
    for (const bad of ["dir\\sub", "C:dir", "/home/dev", "\\\\server", '"', "", "~"]) {
      expect(parseCwdOsc(`9;${bad}`)).toEqual({ kind: "invalid" });
    }
    expect(parseCwdOsc('9;"C:\\x')).toEqual({ kind: "invalid" });
  });

  it("leaves every other OSC 9 to xterm.js", () => {
    expect(parseCwdOsc("Build finished")).toEqual({ kind: "other" });
    expect(parseCwdOsc("")).toEqual({ kind: "other" });
    expect(parseCwdOsc("9")).toEqual({ kind: "other" });
    expect(parseCwdOsc("4;1;50")).toEqual({ kind: "other" });
  });
});

describe("validCwd", () => {
  it("accepts absolute Windows paths only", () => {
    expect(validCwd("C:\\")).toBe(true);
    expect(validCwd("c:/x")).toBe(true);
    expect(validCwd("\\\\nas\\share")).toBe(true);
    expect(validCwd("")).toBe(false);
    expect(validCwd("C:")).toBe(false);
  });
});
