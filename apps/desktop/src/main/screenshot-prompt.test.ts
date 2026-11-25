import { describe, expect, it } from "vitest";
import {
  assertNoPromptLeak,
  DIRECTORY_PROMPT,
  findPromptLeak,
  NEUTRAL_PROMPT,
  waitNoPromptLeak,
} from "./screenshot-prompt.js";

describe("findPromptLeak", () => {
  it.each([
    ["user@host:~$ ls", "a default Linux prompt"],
    ["dev@PC-01:/mnt/c$", "a prompt with a dash in the host"],
    ["a.b@host.local:/", "a prompt with dots"],
    ["C:\\Users\\someone>dir", "a cmd prompt in a user profile"],
    ["PS c:\\users\\Someone\\Desktop>", "a PowerShell prompt in lower case"],
    ["(venv) user@host:~$ ", "a prompt after a virtualenv prefix"],
    ["/mnt/c/Users/someone/Desktop $", "a path into a Windows profile in WSL"],
    ["user@host:\u00a0~$", "a prompt after a no-break space is still a prompt"],
  ])("finds %s (%s)", (row) => {
    expect(findPromptLeak(["$ ", row])).toBe(row.replaceAll("\u00a0", " "));
  });

  it.each([
    "$ ls --color /",
    "$ ",
    "C:\\>",
    "C:\\Users\\Public>",
    "mail me at user@host.example",
    "bin  boot  dev  etc",
    "",
  ])("passes %j", (row) => {
    expect(findPromptLeak([row])).toBeUndefined();
  });

  it("returns the first leaking row", () => {
    expect(findPromptLeak(["$ ", "a@b:1", "c@d:2"])).toBe("a@b:1");
  });
});

describe("assertNoPromptLeak", () => {
  it("names the picture, the rule and the row number, but not the row", () => {
    const rows = ["$ ", "secretuser@secrethost:~$ ls"];
    expect(() => assertNoPromptLeak("46-x.png", rows)).toThrow(
      /46-x\.png: the prompt shows user or host name.*NEUTRAL_PROMPT.*Row 2 /,
    );
    expect(() => assertNoPromptLeak("46-x.png", rows)).not.toThrow(/secret/);
  });

  it("passes neutral rows", () => {
    expect(() => assertNoPromptLeak("01.png", ["$ uname -sr", "Linux 6.6"])).not.toThrow();
  });
});

describe("waitNoPromptLeak", () => {
  it("passes once the rows are neutral and does not wait before that", async () => {
    const reads = [["nic@pc:/$ "], ["nic@pc:/$ "], ["$ "]];
    let calls = 0;
    await waitNoPromptLeak("a.png", async () => reads[calls++] ?? [], 1_000, 1);
    expect(calls).toBe(3);
  });

  it("fails with the rule after the timeout", async () => {
    let calls = 0;
    await expect(
      waitNoPromptLeak(
        "a.png",
        async () => {
          calls++;
          return ["x@y:/$ "];
        },
        30,
        5,
      ),
    ).rejects.toThrow(/a\.png: the prompt shows user or host name/);
    expect(calls).toBeGreaterThan(1);
  });
});

describe("DIRECTORY_PROMPT", () => {
  it("sets a prompt with the directory that is no leak", () => {
    expect(DIRECTORY_PROMPT).toBe("PS1='\\w $ '; clear\r");
    expect(findPromptLeak(["/usr/share/doc $ "])).toBeUndefined();
  });
});

describe("NEUTRAL_PROMPT", () => {
  it("sets a short prompt, clears the screen and presses Enter", () => {
    expect(NEUTRAL_PROMPT).toBe("PS1='$ '; clear\r");
  });
});
