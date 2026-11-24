// Syntax check of project paths per backend (spec workspaces). No file system access, no normalization.
import type { BackendKind } from "@termdock/protocol";

/** Drive path (`C:\dir`, `C:/dir`) or UNC path (`\\server\share`). */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/;

/**
 * Whether `path` is an absolute Windows path (drive or UNC): projects of backend "windows" and the Windows backend's
 * working directories and program paths (#65) share this one rule.
 */
export function isWindowsPath(path: string): boolean {
  return WINDOWS_PATH.test(path);
}

/** Returns the reason when `path` does not have the syntax of its backend, otherwise undefined. */
export function projectPathProblem(path: string, backend: BackendKind): string | undefined {
  if (backend === "wsl") {
    return path.startsWith("/")
      ? undefined
      : `path "${shorten(path)}" must be an absolute Linux path for backend "wsl"`;
  }
  return isWindowsPath(path)
    ? undefined
    : `path "${shorten(path)}" must be a Windows path (C:\\dir or \\\\server\\share) for backend "windows"`;
}

function shorten(path: string): string {
  return path.length > 64 ? `${path.slice(0, 64)}...` : path;
}
