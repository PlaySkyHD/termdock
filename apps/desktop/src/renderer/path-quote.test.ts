// Issue #203 (openspec change explorer-actions): the path the explorer pastes into the terminal, quoted for the shell.
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@termdock/protocol";
import { pasteShell, quotePath } from "./path-quote.js";

const session = (launch: Omit<SessionInfo["launch"], "cwd">): Pick<SessionInfo, "launch"> => ({
  launch: { cwd: "/", ...launch },
});

describe("quotePath", () => {
  it("quotes a Linux path in POSIX single quotes and closes, escapes and reopens for a quote", () => {
    expect(quotePath("/tmp/p/a b.txt", "posix")).toBe("'/tmp/p/a b.txt'");
    expect(quotePath("/tmp/it's.txt", "posix")).toBe("'/tmp/it'\\''s.txt'");
    // Nothing else is special inside single quotes: $, backticks, ", \ and ! stay as they are.
    expect(quotePath('/tmp/$HOME `x` "y" \\z !1', "posix")).toBe("'/tmp/$HOME `x` \"y\" \\z !1'");
  });

  it("quotes for PowerShell in single quotes and doubles every quote, the typographic ones too", () => {
    expect(quotePath("C:\\Users\\Public\\a b.txt", "pwsh")).toBe("'C:\\Users\\Public\\a b.txt'");
    expect(quotePath("C:\\it's\\$env:x", "powershell")).toBe("'C:\\it''s\\$env:x'");
    expect(quotePath("C:\\a\u2019b\u2018c", "pwsh")).toBe("'C:\\a\u2019\u2019b\u2018\u2018c'");
  });

  it("quotes for cmd in double quotes", () => {
    expect(quotePath("C:\\Users\\Public\\a & b.txt", "cmd")).toBe('"C:\\Users\\Public\\a & b.txt"');
  });

  it("refuses a path with a control character: a line break would be an Enter in the shell", () => {
    expect(quotePath("/tmp/a\nb", "posix")).toBeUndefined();
    expect(quotePath("/tmp/a\rb", "posix")).toBeUndefined();
    expect(quotePath("/tmp/a\u001bb", "posix")).toBeUndefined();
    expect(quotePath("C:\\a\tb", "cmd")).toBeUndefined();
  });

  it("never ends in a line break", () => {
    for (const shell of ["posix", "pwsh", "powershell", "cmd"] as const)
      expect(quotePath("/tmp/x", shell)).not.toMatch(/[\r\n]$/);
  });
});

describe("pasteShell", () => {
  it("takes POSIX for WSL and the shell of a Windows session, PowerShell without one", () => {
    expect(pasteShell(session({ backend: "wsl", distro: "Ubuntu" }))).toBe("posix");
    expect(pasteShell(session({ backend: "windows", shell: "cmd" }))).toBe("cmd");
    expect(pasteShell(session({ backend: "windows", shell: "powershell" }))).toBe("powershell");
    expect(pasteShell(session({ backend: "windows" }))).toBe("pwsh");
  });
});
