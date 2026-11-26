// Path checks and translation of the file access (ADR 0009). Pure: no file system, no Electron.
// The renderer is not trusted, so every location is checked here before it reaches `fs`.
import path from "node:path";
import { MAX_FILE_NAME_BYTES, MAX_FILE_PATH_LENGTH } from "../shared/files.js";
import type { FileLocation } from "../shared/files.js";

/** Names `wsl.exe -l` reports: letters, digits, dot, dash, underscore, no path separators. */
const DISTRO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Control characters (C0, DEL and C1). */
const CONTROL = /\p{Cc}/u;
const WINDOWS_RESERVED_CHARS = /[<>:"|?*]/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function isValidDistroName(name: unknown): name is string {
  return typeof name === "string" && DISTRO_NAME.test(name);
}

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]/).includes("..");
}

/** The normalized Linux path, or undefined when it is not an acceptable absolute path. */
export function checkWslPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_FILE_PATH_LENGTH)
    return undefined;
  // A backslash would be a separator in the UNC path and could leave the distro folder's structure.
  if (!value.startsWith("/") || CONTROL.test(value) || value.includes("\\") || hasParentSegment(value)) {
    return undefined;
  }
  return path.posix.normalize(value);
}

/** The normalized Windows path (backslashes), or undefined: only `C:\…`, no UNC, device or stream paths. */
export function checkWindowsPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_FILE_PATH_LENGTH)
    return undefined;
  if (!/^[A-Za-z]:[\\/]/.test(value) || CONTROL.test(value) || hasParentSegment(value)) return undefined;
  const rest = value.slice(2);
  if (WINDOWS_RESERVED_CHARS.test(rest)) return undefined;
  for (const segment of rest.split(/[\\/]/)) {
    if (segment !== "" && WINDOWS_DEVICE.test(segment)) return undefined;
  }
  return path.win32.normalize(value);
}

/**
 * The path a native dialog returned, normalized, or undefined. The user chose it, so a share (`\\server\share\x`)
 * is fine; device and extended-length prefixes (`\\?\`, `\\.\`), relative paths and control characters are not.
 */
export function checkDialogPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return undefined;
  if (CONTROL.test(value) || hasParentSegment(value) || /^[\\/]{2}[?.][\\/]/.test(value)) return undefined;
  if (!path.win32.isAbsolute(value) || /^[\\/][^\\/]/.test(value)) return undefined;
  return path.win32.normalize(value);
}

/** The location with its path normalized, or undefined. Shape and content are both checked. */
export function checkLocation(
  location: FileLocation,
  knownDistros?: readonly string[],
): FileLocation | undefined {
  if (location.backend === "wsl") {
    if (!isValidDistroName(location.distro)) return undefined;
    if (knownDistros && !knownDistros.includes(location.distro)) return undefined;
    const normalized = checkWslPath(location.path);
    return normalized === undefined
      ? undefined
      : { backend: "wsl", distro: location.distro, path: normalized };
  }
  const normalized = checkWindowsPath(location.path);
  return normalized === undefined ? undefined : { backend: "windows", path: normalized };
}

/** The UNC root of a distro as Windows reaches it (ADR 0009). */
export function wslRootOf(distro: string): string {
  return `\\\\wsl.localhost\\${distro}`;
}

/**
 * The path `fs` uses for a checked location. `root` maps a distro to its folder (the UNC root; tests point it at a
 * temporary folder).
 */
export function toFsPath(location: FileLocation, root: (distro: string) => string = wslRootOf): string {
  if (location.backend === "windows") return location.path;
  return `${root(location.distro)}${location.path.replaceAll("/", "\\")}`;
}

/** True for `/` and for `C:\`: what delete and move refuse to touch. */
export function isRoot(location: FileLocation): boolean {
  return location.backend === "wsl"
    ? location.path === "/"
    : path.win32.parse(location.path).root === location.path;
}

/** The folder of a location, or undefined for a root. */
export function parentOf(location: FileLocation): FileLocation | undefined {
  if (isRoot(location)) return undefined;
  return location.backend === "wsl"
    ? { backend: "wsl", distro: location.distro, path: path.posix.dirname(location.path) }
    : { backend: "windows", path: path.win32.dirname(location.path) };
}

/** The entry `name` inside the folder `dir`. */
export function childOf(dir: FileLocation, name: string): FileLocation {
  return dir.backend === "wsl"
    ? { backend: "wsl", distro: dir.distro, path: path.posix.join(dir.path, name) }
    : { backend: "windows", path: path.win32.join(dir.path, name) };
}

export function nameOf(location: FileLocation): string {
  return location.backend === "wsl" ? path.posix.basename(location.path) : path.win32.basename(location.path);
}

/** True when both locations are on the same backend (and the same distro). */
export function sameBackend(a: FileLocation, b: FileLocation): boolean {
  return a.backend === "wsl" ? b.backend === "wsl" && a.distro === b.distro : b.backend === "windows";
}

/** True when `inner` is `outer` or lies below it. Both are checked locations of the same backend. */
export function isInside(outer: FileLocation, inner: FileLocation): boolean {
  if (!sameBackend(outer, inner)) return false;
  if (outer.backend === "wsl") {
    const prefix = outer.path.endsWith("/") ? outer.path : `${outer.path}/`;
    return inner.path === outer.path || inner.path.startsWith(prefix);
  }
  const lower = (value: string): string => value.toLowerCase();
  const prefix = outer.path.endsWith("\\") ? outer.path : `${outer.path}\\`;
  return lower(inner.path) === lower(outer.path) || lower(inner.path).startsWith(lower(prefix));
}

/** True for a name that may be given to an entry: one segment, no separator or control character. */
export function isValidEntryName(name: unknown, backend: FileLocation["backend"]): name is string {
  if (typeof name !== "string" || name.length === 0 || name === "." || name === "..") return false;
  if (Buffer.byteLength(name, "utf8") > MAX_FILE_NAME_BYTES) return false;
  if (name.includes("/") || name.includes("\\") || CONTROL.test(name)) return false;
  if (backend === "windows") {
    if (WINDOWS_RESERVED_CHARS.test(name) || WINDOWS_DEVICE.test(name)) return false;
    if (name.endsWith(".") || name.endsWith(" ")) return false;
  }
  return true;
}

/** File types the system would run when opened; `open` refuses them (ADR 0009). */
const PROGRAM_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".py",
  ".pyw",
  ".ws",
  ".wsc",
  ".inf",
  ".scf",
  ".application",
  ".library-ms",
  ".settingcontent-ms",
  ".msix",
  ".appx",
  ".msixbundle",
  ".appxbundle",
  ".chm",
  ".msc",
  ".ps1xml",
  ".psc1",
  ".com",
  ".scr",
  ".pif",
  ".bat",
  ".cmd",
  ".ps1",
  ".psm1",
  ".vbs",
  ".vbe",
  ".js",
  ".jse",
  ".wsf",
  ".wsh",
  ".hta",
  ".msi",
  ".msp",
  ".lnk",
  ".url",
  ".reg",
  ".cpl",
  ".jar",
  ".appref-ms",
  ".gadget",
  ".sh",
]);

export function isProgramName(name: string): boolean {
  // Windows drops trailing dots and spaces from a name: `run.bat.` is `run.bat`.
  return PROGRAM_EXTENSIONS.has(path.extname(name.replace(/[. ]+$/, "")).toLowerCase());
}
