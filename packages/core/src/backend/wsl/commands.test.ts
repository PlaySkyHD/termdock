import { describe, expect, it } from "vitest";
import type { LaunchSpec } from "@termdock/protocol";
import {
  attachArgs,
  hasSessionArgs,
  isMissingSession,
  keepaliveArgs,
  killSessionArgs,
  parseDistroList,
  parsePaneStatus,
  parseSnapshot,
  paneStatusArgs,
  sessionName,
  snapshotArgs,
  startArgs,
  versionArgs,
} from "./commands.js";

const target = { distro: "Ubuntu", socket: "termdock-test" };
const spec = (extra: Partial<LaunchSpec> = {}): LaunchSpec => ({ backend: "wsl", cwd: "/tmp", ...extra });
const decoder = new TextDecoder();

describe("sessionName", () => {
  it("prefixes the id with td-", () => {
    expect(sessionName("3f2a-11_x")).toBe("td-3f2a-11_x");
  });

  it.each(["", "a:b", "a.b", "a b", "a;b", "a'b", "ä"])("rejects id %j", (id) => {
    expect(() => sessionName(id)).toThrow(/session id/i);
  });
});

describe("startArgs", () => {
  it("starts tmux via --exec in the working directory with status off, remain-on-exit and the exit hook", () => {
    expect(startArgs(target, "abc", spec())).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "/tmp",
      "--exec",
      "tmux",
      "-L",
      "termdock-test",
      "-T",
      "RGB",
      "new-session",
      "-A",
      "-s",
      "td-abc",
      ";",
      "set-option",
      "-t",
      "=td-abc:",
      "status",
      "off",
      ";",
      "set-option",
      "-w",
      "-t",
      "=td-abc:",
      "remain-on-exit",
      "on",
      ";",
      "set-hook",
      "-t",
      "=td-abc:",
      "pane-died",
      "detach-client -s =td-abc",
    ]);
  });

  it("passes the command arguments verbatim after the session name", () => {
    const args = startArgs(target, "abc", spec({ command: ["printf", "%s", "$HOME a;b"] }));
    expect(args.slice(args.indexOf("td-abc"), args.indexOf(";"))).toEqual([
      "td-abc",
      "printf",
      "%s",
      "$HOME a;b",
    ]);
  });

  // tmux strips one backslash before a trailing ; (verified against tmux 3.6), so one is inserted.
  it.each([
    [";", "\\;"],
    ["a;", "a\\;"],
    [";;", ";\\;"],
    ["a\\;", "a\\\\;"],
    ["a;b", "a;b"],
    ["a\\", "a\\"],
  ])("escapes a trailing ; of the command argument %j so tmux passes it on literally", (arg, escaped) => {
    const args = startArgs(target, "abc", spec({ command: ["prog", arg] }));
    expect(args.slice(args.indexOf("td-abc"), args.indexOf(";"))).toEqual(["td-abc", "prog", escaped]);
  });

  it("leaves only the generated separators for command-injection arguments", () => {
    for (const command of [
      ["sh", "-c", "x", ";", "kill-server"],
      ["find", ".", "-exec", "rm", "{}", ";"],
    ]) {
      const args = startArgs(target, "abc", spec({ command }));
      expect(args.filter((arg) => arg.endsWith(";") && !arg.endsWith("\\;"))).toHaveLength(3);
    }
  });

  it("escapes a single-element command and environment values ending in ;", () => {
    const single = startArgs(target, "abc", spec({ command: ["a;"] }));
    expect(single.slice(single.indexOf("td-abc"), single.indexOf(";"))).toEqual([
      "td-abc",
      "env",
      "--",
      "a\\;",
    ]);
    const env = startArgs(target, "abc", spec({ env: { X: "a;", Y: "b" } }));
    expect(env.slice(env.indexOf("-e"), env.indexOf(";"))).toEqual(["-e", "X=a\\;", "-e", "Y=b"]);
  });

  it("prefixes a single-element command with env -- so tmux does not hand it to sh -c", () => {
    const args = startArgs(target, "abc", spec({ command: ["htop"] }));
    expect(args.slice(args.indexOf("td-abc"), args.indexOf(";"))).toEqual(["td-abc", "env", "--", "htop"]);
  });

  it("sets environment variables with -e before the command", () => {
    const args = startArgs(target, "abc", spec({ env: { FOO: "a b", BAR_2: "x=y" }, command: ["a", "b"] }));
    expect(args.slice(args.indexOf("new-session"), args.indexOf(";"))).toEqual([
      "new-session",
      "-A",
      "-s",
      "td-abc",
      "-e",
      "FOO=a b",
      "-e",
      "BAR_2=x=y",
      "a",
      "b",
    ]);
  });

  it("rejects invalid environment variable names", () => {
    expect(() => startArgs(target, "abc", spec({ env: { "A=B": "x" } }))).toThrow(/environment/i);
    expect(() => startArgs(target, "abc", spec({ env: { "1A": "x" } }))).toThrow(/environment/i);
  });

  it("allows ~ as working directory and rejects an empty one", () => {
    expect(startArgs(target, "abc", spec({ cwd: "~" })).slice(0, 5)).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "~",
      "--exec",
    ]);
    expect(() => startArgs(target, "abc", spec({ cwd: "" }))).toThrow(/working directory/i);
  });
});

describe("other tmux commands", () => {
  it("attaches with -T RGB to the exact session", () => {
    // Always from ~: a missing working directory must not break re-attaching to a live session.
    expect(attachArgs(target, "abc")).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "~",
      "--exec",
      "tmux",
      "-L",
      "termdock-test",
      "-T",
      "RGB",
      "attach-session",
      "-t",
      "=td-abc",
    ]);
  });

  it("runs commands without PTY from ~", () => {
    const prefix = ["-d", "Ubuntu", "--cd", "~", "--exec", "tmux", "-L", "termdock-test"];
    expect(hasSessionArgs(target, "abc")).toEqual([...prefix, "has-session", "-t", "=td-abc"]);
    expect(killSessionArgs(target, "abc")).toEqual([...prefix, "kill-session", "-t", "=td-abc"]);
    expect(paneStatusArgs(target, "abc")).toEqual([
      ...prefix,
      "has-session",
      "-t",
      "=td-abc",
      ";",
      "display-message",
      "-p",
      "-t",
      "=td-abc:",
      "#{pane_dead} #{pane_dead_status} #{pane_dead_signal}",
    ]);
    expect(snapshotArgs(target, "abc")).toEqual([
      ...prefix,
      "has-session",
      "-t",
      "=td-abc",
      ";",
      "capture-pane",
      "-p",
      "-e",
      "-J",
      "-t",
      "=td-abc:",
      ";",
      "display-message",
      "-p",
      "-t",
      "=td-abc:",
      "#{cursor_x} #{cursor_y} #{cursor_flag}",
    ]);
    expect(versionArgs("Ubuntu")).toEqual(["-d", "Ubuntu", "--cd", "~", "--exec", "tmux", "-V"]);
  });

  it("keeps the distro alive with sleep infinity", () => {
    expect(keepaliveArgs("Debian")).toEqual(["-d", "Debian", "--cd", "~", "--exec", "sleep", "infinity"]);
  });

  it("rejects socket names that are not plain words", () => {
    expect(() => hasSessionArgs({ distro: "Ubuntu", socket: "a/b" }, "abc")).toThrow(/socket/i);
  });
});

describe("parsers", () => {
  it("recognises tmux messages for a missing session or server", () => {
    expect(isMissingSession({ code: 1, stdout: "", stderr: "can't find session: td-x\n" })).toBe(true);
    expect(isMissingSession({ code: 1, stdout: "", stderr: "no server running on /tmp/tmux-1000/x\n" })).toBe(
      true,
    );
    expect(
      isMissingSession({
        code: 1,
        stdout: "",
        stderr: "error connecting to /tmp/tmux-1000/x (No such file)",
      }),
    ).toBe(true);
    expect(isMissingSession({ code: 127, stdout: "", stderr: "Wsl/Service/WSL_E_DISTRO_NOT_FOUND" })).toBe(
      false,
    );
    expect(isMissingSession({ code: null, stdout: "", stderr: "can't find session", timedOut: true })).toBe(
      false,
    );
  });

  it("parses the pane status", () => {
    expect(parsePaneStatus("0  \n")).toEqual({ dead: false });
    expect(parsePaneStatus("1 7 \n")).toEqual({ dead: true, exitCode: 7 });
    expect(parsePaneStatus("1  9\n")).toEqual({ dead: true, exitCode: 137 });
    expect(parsePaneStatus("1  \n")).toEqual({ dead: true });
  });

  it("splits a snapshot into screen and cursor, with CRLF line ends and the cursor positioned in the data", () => {
    const snapshot = parseSnapshot("\x1b[31mred\x1b[39m\nline 2\n\n0 3 1\n");
    expect(decoder.decode(snapshot.data)).toBe("\x1b[31mred\x1b[39m\r\nline 2\r\n\x1b[0m\x1b[4;1H\x1b[?25h");
    expect(snapshot.cursor).toEqual({ x: 0, y: 3 });
  });

  it("hides the cursor after positioning it when tmux reports it hidden", () => {
    const snapshot = parseSnapshot("screen\n9 4 0\n");
    expect(decoder.decode(snapshot.data)).toBe("screen\x1b[0m\x1b[5;10H\x1b[?25l");
  });

  it("omits the cursor when the last line is not a position", () => {
    const snapshot = parseSnapshot("text\n");
    expect(decoder.decode(snapshot.data)).toBe("text");
    expect(snapshot.cursor).toBeUndefined();
  });

  it("parses the distro list and finds the default", () => {
    const output =
      "  NAME            STATE           VERSION\r\n* Ubuntu          Stopped         2\r\n  docker-desktop  Stopped         2\r\n";
    expect(parseDistroList(output)).toEqual({ names: ["Ubuntu", "docker-desktop"], defaultDistro: "Ubuntu" });
  });

  it("tolerates UTF-16 null bytes and lists without marker", () => {
    const output = "N\0A\0M\0E\0 STATE VERSION\r\n  Debian Running 2\r\n  Ubuntu Stopped 2\r\n";
    expect(parseDistroList(output)).toEqual({ names: ["Debian", "Ubuntu"], defaultDistro: "Debian" });
    expect(parseDistroList("")).toEqual({ names: [], defaultDistro: undefined });
  });
});
