import { describe, expect, it } from "vitest";
import { defaultCwd } from "./default-cwd.js";

describe("defaultCwd", () => {
  const project = { path: "/p" };
  const workspace = { defaultCwd: "/w" };
  const settings = { defaultCwd: "/s" };

  it("prefers project, then workspace, then setting, then the home directory", () => {
    const backend = "wsl";
    expect(defaultCwd({ backend, project, workspace, settings })).toBe("/p");
    expect(defaultCwd({ backend, workspace, settings })).toBe("/w");
    expect(defaultCwd({ backend, workspace: {}, settings })).toBe("/s");
    expect(defaultCwd({ backend, workspace: {}, settings: {} })).toBe("~");
    expect(defaultCwd({ backend })).toBe("~");
  });

  it("skips values whose syntax does not fit the backend", () => {
    expect(
      defaultCwd({
        backend: "wsl",
        project: { path: "C:\\dev" },
        workspace: { defaultCwd: "D:\\w" },
        settings,
      }),
    ).toBe("/s");
    expect(
      defaultCwd({ backend: "wsl", project: { path: "C:\\dev" }, settings: { defaultCwd: "E:\\s" } }),
    ).toBe("~");
    expect(
      defaultCwd({
        backend: "windows",
        project,
        workspace: { defaultCwd: "D:\\w" },
        settings: { defaultCwd: "/s" },
      }),
    ).toBe("D:\\w");
    // Placeholder fallback for windows until #65.
    expect(defaultCwd({ backend: "windows", project, workspace, settings })).toBe("~");
  });
});
