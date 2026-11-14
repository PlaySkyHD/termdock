import { describe, expect, it } from "vitest";
import { projectPathProblem } from "./paths.js";

describe("projectPathProblem", () => {
  it.each(["/", "/home/dev/api", "/mnt/c/Users/dev", "/home/dev/with space", "/a\\b"])(
    "accepts the Linux path %s for wsl",
    (path) => {
      expect(projectPathProblem(path, "wsl")).toBeUndefined();
    },
  );

  it.each(["C:\\dev\\api", "d:/dev/api", "C:\\", "\\\\server\\share", "\\\\server/share\\dir"])(
    "accepts the Windows path %s for windows",
    (path) => {
      expect(projectPathProblem(path, "windows")).toBeUndefined();
    },
  );

  it.each(["home/dev", "C:\\dev", "~/dev", "./x", "\\\\server"])(
    "rejects %s for wsl or reports it",
    (path) => {
      expect(projectPathProblem(path, "wsl")).toContain("Linux path");
    },
  );

  it.each(["/home/dev", "dev\\api", "C:dev", "C:", "\\\\server", "\\\\\\share", "~"])(
    "rejects %s for windows",
    (path) => {
      expect(projectPathProblem(path, "windows")).toContain("Windows path");
    },
  );

  it("shortens a long path in the message", () => {
    const message = projectPathProblem(`x${"y".repeat(500)}`, "wsl");
    expect(message?.length).toBeLessThan(200);
  });
});
