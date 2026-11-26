// The current directory of a Windows shell (#200): the prompt hook of the core sends `ESC ] 9 ; 9 ; "<path>" ESC \`
// (ConEmu / Windows Terminal, OSC 9;9). Pure: xterm.js hands the data of the OSC to `parseCwdOsc`; the terminal
// output is data, so a path with control characters or an odd form is dropped and never used.

/** Longest path accepted; the same limit as every other path of the protocol (`MAX_PATH_LENGTH`). */
export const MAX_CWD_LENGTH = 512;

/** `C:\dir`, `C:/dir` or `\\server\share`, the forms of `isWindowsPath` in the core. */
const ABSOLUTE_WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/;

/** C0 and C1 control characters and DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * What an OSC 9 means: `cwd` a valid directory, `invalid` a directory report that is not accepted (dropped, but it
 * is still ours), `other` any other OSC 9 (notification, progress of ConEmu): the caller leaves it to xterm.js.
 */
export type CwdOsc = { kind: "cwd"; path: string } | { kind: "invalid" } | { kind: "other" };

/** Parses the data of an OSC 9 as xterm.js passes it (without the `9`'s own number: `9;"C:\dir"` or `9;C:\dir`). */
export function parseCwdOsc(data: string): CwdOsc {
  if (!data.startsWith("9;")) return { kind: "other" };
  let path = data.slice(2);
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  return validCwd(path) ? { kind: "cwd", path } : { kind: "invalid" };
}

/** Whether `path` is an absolute Windows path of at most `MAX_CWD_LENGTH` characters without control characters. */
export function validCwd(path: string): boolean {
  return path.length <= MAX_CWD_LENGTH && ABSOLUTE_WINDOWS_PATH.test(path) && !CONTROL.test(path);
}
