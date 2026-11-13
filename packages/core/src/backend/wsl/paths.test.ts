import { describe, expect, it } from "vitest";
import { wslPath } from "./paths.js";

describe("wslPath", () => {
  it.each([
    ["P:\\x", "/mnt/p/x"],
    ["P:/GitHub/termdock", "/mnt/p/GitHub/termdock"],
    ["c:\\Users\\a b\\", "/mnt/c/Users/a b"],
    ["D:\\", "/mnt/d"],
    ["D:", "/mnt/d"],
  ])("maps %j to %j", (input, expected) => {
    expect(wslPath(input)).toBe(expected);
  });

  it.each(["relative\\x", "\\\\server\\share", "/already/linux", ""])("rejects %j", (input) => {
    expect(() => wslPath(input)).toThrow(/windows path/i);
  });
});
