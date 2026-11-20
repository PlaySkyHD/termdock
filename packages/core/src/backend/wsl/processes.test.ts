import { describe, expect, it } from "vitest";
import { failureText } from "./processes.js";

describe("runWsl failure text (issue #149)", () => {
  it("names the exit code, the signal or the start error and nothing else", () => {
    expect(failureText({ code: 1 })).toBe("wsl.exe failed: exit code 1");
    expect(failureText({ signal: "SIGTERM" })).toBe("wsl.exe failed: ended by signal SIGTERM");
    expect(failureText({ code: "ENOENT" })).toBe("wsl.exe failed: ENOENT");
    expect(failureText({})).toBe("wsl.exe failed: could not run");
  });

  it("takes no argument vector and no message, so a value in the arguments cannot reach it", () => {
    // The old text was Node's message: "Command failed: wsl.exe ... --exec env TD_TEST_VALUE=td-test-secret-0000".
    const failure = {
      code: 1,
      message: "Command failed: wsl.exe --exec env TD_TEST_VALUE=td-test-secret-0000",
      cmd: "wsl.exe --exec env TD_TEST_VALUE=td-test-secret-0000",
    };
    expect(failureText(failure)).not.toContain("td-test-secret-0000");
  });
});
