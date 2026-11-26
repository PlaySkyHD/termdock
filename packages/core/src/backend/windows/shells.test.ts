import { describe, expect, it } from "vitest";
import {
  POWERSHELL_CWD_HOOK,
  defaultShell,
  promptHookEnvironment,
  envValue,
  findProgram,
  findShell,
  launchProgram,
  shellCandidates,
  shellEnvironment,
  shellMissingMessage,
  windowsCwd,
} from "./shells.js";
import type { ShellLookup } from "./shells.js";

const env = {
  SystemRoot: "C:\\Windows",
  ProgramFiles: "C:\\Program Files",
  Path: 'relative\\bin;C:\\Tools;"C:\\Quoted Dir";;D:\\bin',
};

/** A file system with `files`; a path in `hanging` never answers. */
function lookup(
  files: string[],
  overrides: Record<string, string | undefined> = {},
  hanging: string[] = [],
): ShellLookup {
  const known = new Set(files.map((file) => file.toLowerCase()));
  return {
    env: { ...env, ...overrides },
    isFile: (file) =>
      hanging.some((dir) => file.startsWith(dir))
        ? new Promise<boolean>(() => {})
        : Promise.resolve(known.has(file.toLowerCase())),
    timeoutMs: 20,
  };
}

describe("findShell (issue #65)", () => {
  it("takes the known places first: System32 for cmd and powershell, the PowerShell 7 folder for pwsh", async () => {
    const all = lookup([
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "C:\\Tools\\cmd.exe",
    ]);
    expect(await findShell("cmd", all)).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(await findShell("powershell", all)).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(await findShell("pwsh", all)).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  });

  it("then searches each absolute PATH directory, skips relative and empty ones and strips quotes", async () => {
    expect(shellCandidates("pwsh", env)).toEqual([
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "C:\\Tools\\pwsh.exe",
      "C:\\Quoted Dir\\pwsh.exe",
      "D:\\bin\\pwsh.exe",
    ]);
    expect(await findShell("pwsh", lookup(["D:\\bin\\pwsh.exe", "C:\\Quoted Dir\\pwsh.exe"]))).toBe(
      "C:\\Quoted Dir\\pwsh.exe",
    );
  });

  it("is undefined when the shell is installed nowhere", async () => {
    expect(await findShell("pwsh", lookup([]))).toBeUndefined();
  });

  it("counts a PATH directory that does not answer as absent and still finds a later one (hung share)", async () => {
    const hung = lookup(["D:\\bin\\pwsh.exe"], { Path: "\\\\nas\\tools;D:\\bin" }, ["\\\\nas"]);
    const started = Date.now();
    expect(await findShell("pwsh", hung)).toBe("D:\\bin\\pwsh.exe");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reads PATH and SystemRoot in any case", async () => {
    expect(envValue({ PATH: "x" }, "Path")).toBe("x");
    const upper = lookup(["E:\\w\\System32\\cmd.exe"], { SystemRoot: undefined, SYSTEMROOT: "E:\\w" });
    expect(await findShell("cmd", upper)).toBe("E:\\w\\System32\\cmd.exe");
  });
});

describe("defaultShell", () => {
  it("is pwsh when PowerShell 7 is installed, else Windows PowerShell", async () => {
    expect(await defaultShell(lookup(["C:\\Program Files\\PowerShell\\7\\pwsh.exe"]))).toBe("pwsh");
    expect(await defaultShell(lookup([]))).toBe("powershell");
  });
});

describe("findProgram", () => {
  it("finds a bare name in PATH with .exe or .com, and an absolute path as it is or with .exe", async () => {
    const files = lookup(["D:\\bin\\git.exe", "C:\\Tools\\more.com", "C:\\x\\app.exe"]);
    expect(await findProgram("git", files)).toEqual({ file: "D:\\bin\\git.exe" });
    expect(await findProgram("git.exe", files)).toEqual({ file: "D:\\bin\\git.exe" });
    expect(await findProgram("more", files)).toEqual({ file: "C:\\Tools\\more.com" });
    expect(await findProgram("C:\\x\\app", files)).toEqual({ file: "C:\\x\\app.exe" });
  });

  it("refuses a batch file given by absolute path, whatever the case of its extension (BatBadBut)", async () => {
    const files = lookup(["C:\\tools\\build.cmd", "C:\\tools\\run.BAT"]);
    expect(await findProgram("C:\\tools\\build.cmd", files)).toEqual({
      missing:
        'Program C:\\tools\\build.cmd is a batch file (build.cmd): run it as ["cmd.exe", "/d", "/c", "build.cmd", ...]',
    });
    expect(await findProgram("C:\\tools\\run.BAT", files)).toMatchObject({
      missing: expect.stringContaining("is a batch file (run.BAT)"),
    });
  });

  it("explains a batch file, a missing program and a relative path", async () => {
    const files = lookup(["D:\\bin\\npm.cmd"]);
    expect(await findProgram("npm", files)).toEqual({
      missing: 'Program npm is a batch file (npm.cmd): run it as ["cmd.exe", "/d", "/c", "npm.cmd", ...]',
    });
    expect(await findProgram("npm.cmd", files)).toMatchObject({
      missing: expect.stringContaining("batch file"),
    });
    expect(await findProgram("nope", files)).toEqual({ missing: "Program nope was not found in PATH" });
    expect(await findProgram("bin\\tool", files)).toEqual({
      missing: "Program bin\\tool must be a name or an absolute path",
    });
  });
});

describe("launchProgram", () => {
  const shells = lookup([
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "C:\\Windows\\System32\\cmd.exe",
    "D:\\bin\\git.exe",
  ]);

  it("runs the shell with its own arguments and the prompt hook of PowerShell (#200)", async () => {
    const hooked = ["-NoLogo", "-NoExit", "-Command", POWERSHELL_CWD_HOOK];
    expect(await launchProgram({}, "pwsh", shells)).toEqual({
      file: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      args: hooked,
    });
    expect(await launchProgram({}, "powershell", shells)).toMatchObject({ args: hooked });
    expect(await launchProgram({ command: [] }, "cmd", shells)).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: [],
    });
  });

  it("runs a command as an argument array, its program found in PATH, without the shell", async () => {
    const program = await launchProgram(
      { command: ["git", "log", "--format=%H; rm -rf /"] },
      "pwsh",
      lookup(["D:\\bin\\git.exe"]),
    );
    expect(program).toEqual({ file: "D:\\bin\\git.exe", args: ["log", "--format=%H; rm -rf /"] });
  });

  it("sets no hook arguments when the spec has its own command (#200)", async () => {
    const program = await launchProgram(
      { command: ["pwsh", "-Command", "echo x"] },
      "pwsh",
      lookup(["D:\\bin\\pwsh.exe"]),
    );
    expect(program).toEqual({ file: "D:\\bin\\pwsh.exe", args: ["-Command", "echo x"] });
  });

  it("names a missing shell and the other shells", async () => {
    expect(await launchProgram({}, "pwsh", lookup([]))).toEqual({ error: shellMissingMessage("pwsh") });
    expect(shellMissingMessage("pwsh")).toBe(
      "PowerShell 7 (pwsh.exe) is not installed on this computer: install it or choose powershell or cmd",
    );
  });
});

describe("windowsCwd", () => {
  const home = "C:\\Users\\dev";
  it("puts ~ and paths below it into the home directory and keeps absolute Windows paths", () => {
    expect(windowsCwd("~", home)).toBe(home);
    expect(windowsCwd("~\\src", home)).toBe("C:\\Users\\dev\\src");
    expect(windowsCwd("~/src/app", home)).toBe("C:\\Users\\dev\\src\\app");
    expect(windowsCwd("D:\\work", home)).toBe("D:\\work");
    expect(windowsCwd("\\\\server\\share\\x", home)).toBe("\\\\server\\share\\x");
  });

  it("names no directory for Linux, relative or drive-relative paths", () => {
    expect(windowsCwd("/home/dev", home)).toBeUndefined();
    expect(windowsCwd("src", home)).toBeUndefined();
    expect(windowsCwd("C:dev", home)).toBeUndefined();
    expect(windowsCwd("~dev", home)).toBeUndefined();
  });
});

describe("prompt hook (#200)", () => {
  it("is a constant PowerShell script without double quotes, that only wraps prompt and reads the FileSystem path", () => {
    expect(POWERSHELL_CWD_HOOK).not.toContain('"');
    expect(POWERSHELL_CWD_HOOK).not.toContain("\n");
    expect(POWERSHELL_CWD_HOOK).toContain("$function:prompt");
    expect(POWERSHELL_CWD_HOOK).toContain("$PWD.ProviderPath");
    expect(POWERSHELL_CWD_HOOK).toContain("'FileSystem'");
    // A failing hook must leave the prompt as it was: the call of the old prompt and the hook each sit in try.
    expect(POWERSHELL_CWD_HOOK.match(/try \{/g)).toHaveLength(2);
    // The old prompt still sees `$?` of the user's command: caught first, before any statement of the hook.
    expect(POWERSHELL_CWD_HOOK).toContain("function global:prompt { $ok = $?;");
  });

  it("puts the hook in front of PROMPT of cmd, the user's own value or $P$G", () => {
    expect(promptHookEnvironment("cmd", {}, { A: "a" })).toEqual({ A: "a", PROMPT: "$e]9;9;$P$e\\$P$G" });
    expect(promptHookEnvironment("cmd", {}, { Prompt: "$T$G", A: "a" })).toEqual({
      A: "a",
      PROMPT: "$e]9;9;$P$e\\$T$G",
    });
  });

  it("leaves PowerShell and every session with its own command alone, and never changes its input", () => {
    const env = { PROMPT: "x" };
    expect(promptHookEnvironment("pwsh", {}, env)).toEqual({ PROMPT: "x" });
    expect(promptHookEnvironment("cmd", { command: ["cmd.exe", "/c", "echo"] }, env)).toEqual({
      PROMPT: "x",
    });
    promptHookEnvironment("cmd", {}, env);
    expect(env).toEqual({ PROMPT: "x" });
  });
});

describe("shellEnvironment", () => {
  it("drops ELECTRON_RUN_AS_NODE of the core in any case and keeps the rest", () => {
    expect(
      shellEnvironment({ ELECTRON_RUN_AS_NODE: "1", electron_run_as_node: "1", A: "a", U: undefined }, {}),
    ).toEqual({ A: "a" });
  });

  it("drops every TERMDOCK_* variable of the core, so a TermDock in the shell does not take over its pipe or data", () => {
    expect(
      shellEnvironment(
        {
          TERMDOCK_PIPE: "\\\\.\\pipe\\x",
          TERMDOCK_DATA_DIR: "C:\\data",
          termdock_tmux_socket: "s",
          TERMDOCKER: "kept",
          A: "a",
        },
        undefined,
      ),
    ).toEqual({ TERMDOCKER: "kept", A: "a" });
  });

  it("lets launch.env replace a variable of the core whatever its case", () => {
    expect(shellEnvironment({ Path: "C:\\old", HOME: "x" }, { PATH: "C:\\new", EXTRA: "1" })).toEqual({
      HOME: "x",
      PATH: "C:\\new",
      EXTRA: "1",
    });
  });
});
