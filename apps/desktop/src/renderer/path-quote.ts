// The path that "Pfad ins Terminal einfügen" (#203) pastes, quoted for the shell of the session. Pure. The text never
// holds a line break or another control character: `Terminal.paste` turns a line break into CR, an Enter in the shell.
import type { SessionInfo, WindowsShell } from "@termdock/protocol";

export type PasteShell = "posix" | WindowsShell;

/** Control characters (C0, DEL and C1). */
const CONTROL = /\p{Cc}/u;
/** PowerShell ends a single-quoted string at any of these, so each is doubled (about_Quoting_Rules). */
const POWERSHELL_QUOTES = /['‘’‚‛]/g;

/** The shell a pasted path is quoted for: WSL runs a POSIX shell; a Windows session without one runs PowerShell. */
export function pasteShell(session: Pick<SessionInfo, "launch">): PasteShell {
  if (session.launch.backend === "wsl") return "posix";
  return session.launch.shell ?? "pwsh";
}

/**
 * `path` as one argument of `shell`: POSIX in single quotes (`'` → `'\''`), PowerShell in single quotes (`'` → `''`),
 * cmd in double quotes (Windows names hold no `"`). Undefined for a path with a control character, and for cmd with a
 * `%`: cmd expands `%NAME%` also inside double quotes, and nothing escapes it there, so the shell would get another
 * path than the one shown.
 */
export function quotePath(path: string, shell: PasteShell): string | undefined {
  if (CONTROL.test(path)) return undefined;
  if (shell === "cmd" && path.includes("%")) return undefined;
  switch (shell) {
    case "posix":
      return `'${path.replaceAll("'", "'\\''")}'`;
    case "pwsh":
    case "powershell":
      return `'${path.replace(POWERSHELL_QUOTES, (quote) => quote + quote)}'`;
    case "cmd":
      return `"${path}"`;
  }
}
