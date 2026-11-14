import { describe, expect, it } from "vitest";
import { defaultCwd } from "./default-cwd.js";

describe("defaultCwd", () => {
  const project = { path: "/p" };
  const workspace = { defaultCwd: "/w" };
  const settings = { defaultCwd: "/s" };

  it("prefers project, then workspace, then setting, then the home directory", () => {
    expect(defaultCwd({ project, workspace, settings })).toBe("/p");
    expect(defaultCwd({ workspace, settings })).toBe("/w");
    expect(defaultCwd({ workspace: {}, settings })).toBe("/s");
    expect(defaultCwd({ workspace: {}, settings: {} })).toBe("~");
    expect(defaultCwd({})).toBe("~");
    expect(defaultCwd()).toBe("~");
  });
});
