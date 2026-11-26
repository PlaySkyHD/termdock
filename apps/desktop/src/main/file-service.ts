// File access of the explorer (ADR 0009): Node `fs/promises` on Windows paths and on `\\wsl.localhost\<distro>`.
// Free of Electron: dialogs and shell come in as dependencies. Every operation answers with a result, never throws.
import { cp, copyFile, lstat, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { MAX_LIST_ENTRIES } from "../shared/files.js";
import type {
  FileDoneResult,
  FileDownloadResult,
  FileEntry,
  FileErrorCode,
  FileFailure,
  FileListResult,
  FileLocation,
  FileMovedResult,
} from "../shared/files.js";
import {
  checkDialogPath,
  checkLocation,
  childOf,
  isInside,
  isProgramName,
  isRoot,
  isValidEntryName,
  nameOf,
  parentOf,
  sameBackend,
  toFsPath,
} from "./file-paths.js";

/** The dialogs of the download. They return a Windows path, or undefined when the user cancels. */
export interface FileDialogs {
  /** Save dialog for one file, suggesting `defaultName`; the dialog itself asks before overwriting. */
  saveFile(windowId: number, defaultName: string): Promise<string | undefined>;
  /** Folder dialog: the folder a downloaded folder is copied into. */
  chooseFolder(windowId: number): Promise<string | undefined>;
}

/** The parts of Electron's `shell` the service uses. `openPath` resolves with an error text, empty on success. */
export interface FileShell {
  showItemInFolder(fullPath: string): void;
  openPath(fullPath: string): Promise<string>;
}

export interface FileServiceDeps {
  /** The WSL distros that exist (`wsl.distros` of the core). */
  distros(): Promise<readonly string[]>;
  dialogs: FileDialogs;
  shell: FileShell;
  /** Maps a distro to the folder `fs` reaches it at; default `\\wsl.localhost\<distro>`. Tests use a temp folder. */
  wslRoot?: (distro: string) => string;
  /** Only the operation and code are logged, never a path or the text of an OS error. */
  log?: (line: string) => void;
  now?: () => number;
}

/** How long a list of distros is trusted before a miss asks the core again. */
const DISTRO_CACHE_MS = 30_000;
/** How long a miss is trusted before the core is asked again (a new distro shows up after this at the latest). */
const DISTRO_MISS_MS = 5_000;
/** Entries read in parallel; `lstat` on a UNC path is slow, but a few hundred at once is not. */
const STAT_BATCH = 64;

const fail = (code: FileErrorCode): FileFailure => ({ ok: false, code });

/** Maps an `fs` error to the code of the contract; unknown errors are `OTHER`. */
export function codeOf(error: unknown): FileErrorCode {
  switch ((error as { code?: unknown } | null)?.code) {
    case "ENOENT":
      return "ENOENT";
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return "EACCES";
    case "EEXIST":
    case "ENOTEMPTY":
      return "EEXIST";
    case "ENOTDIR":
    case "EISDIR":
    case "EINVAL":
    case "ENAMETOOLONG":
      return "EINVAL";
    default:
      return "OTHER";
  }
}

class Refused extends Error {
  constructor(readonly refusal: FileErrorCode) {
    super(refusal);
  }
}

export class FileService {
  private known: { names: readonly string[]; at: number } | undefined;

  constructor(private readonly deps: FileServiceDeps) {}

  async list(raw: FileLocation): Promise<FileListResult> {
    return this.guard("list", async () => {
      const location = await this.checked(raw);
      const dir = this.fsPath(location);
      const dirents = await readdir(dir, { withFileTypes: true });
      // Folders first, then by name: when the limit cuts the listing, the folders are still there.
      const ordered = dirents
        .map((dirent) => ({ dirent, folder: dirent.isDirectory() }))
        .sort((a, b) => Number(b.folder) - Number(a.folder) || compareNames(a.dirent.name, b.dirent.name));
      const shown = ordered.slice(0, MAX_LIST_ENTRIES);
      const entries: FileEntry[] = [];
      for (let from = 0; from < shown.length; from += STAT_BATCH) {
        const batch = shown.slice(from, from + STAT_BATCH);
        entries.push(...(await Promise.all(batch.map(({ dirent }) => this.entryOf(dir, dirent)))));
      }
      return { ok: true, entries, truncated: dirents.length > shown.length, total: dirents.length };
    });
  }

  async rename(raw: FileLocation, newName: string): Promise<FileMovedResult> {
    return this.guard("rename", async () => {
      const location = await this.checked(raw);
      if (!isValidEntryName(newName, location.backend)) throw new Refused("EINVAL");
      const parent = parentOf(location);
      if (!parent) throw new Refused("EINVAL");
      const target = childOf(parent, newName);
      await this.moveEntry(location, target);
      return { ok: true, location: target };
    });
  }

  async move(raw: FileLocation, rawTarget: FileLocation): Promise<FileMovedResult> {
    return this.guard("move", async () => {
      const location = await this.checked(raw);
      const targetDir = await this.checked(rawTarget);
      // No copy across backends: that would be a download or an upload with its own rules.
      if (isRoot(location) || !sameBackend(location, targetDir) || isInside(location, targetDir)) {
        throw new Refused("EINVAL");
      }
      const target = childOf(targetDir, nameOf(location));
      await this.moveEntry(location, target);
      return { ok: true, location: target };
    });
  }

  async delete(raw: FileLocation): Promise<FileDoneResult> {
    return this.guard("delete", async () => {
      const location = await this.checked(raw);
      if (isRoot(location)) throw new Refused("EINVAL");
      const target = this.fsPath(location);
      // Without `force` a missing entry is `ENOENT`; a symlink is removed itself, never followed.
      await lstat(target);
      await rm(target, { recursive: true });
      return { ok: true };
    });
  }

  async download(windowId: number, raw: FileLocation): Promise<FileDownloadResult> {
    return this.guard("download", async () => {
      const location = await this.checked(raw);
      if (location.backend !== "wsl" || isRoot(location)) throw new Refused("EINVAL");
      const source = this.fsPath(location);
      // A symlink as the chosen entry is followed; symlinks inside a folder are skipped (they need rights on Windows).
      const info = await stat(source);
      const name = nameOf(location);
      let skipped = 0;
      if (info.isDirectory()) {
        const folder = this.windowsTarget(await this.deps.dialogs.chooseFolder(windowId));
        if (folder === undefined) return { ok: true, cancelled: true, skipped: 0 };
        const destination = childOf({ backend: "windows", path: folder }, name).path;
        // `cp` would merge into an existing folder; a download never touches what is there.
        if (await exists(destination)) throw new Refused("EEXIST");
        // Entries Windows cannot hold (a `:` makes a data stream, `nul` a device) and symlinks are skipped and counted.
        const skip = async (from: string): Promise<boolean> =>
          from !== source &&
          (!isValidEntryName(path.win32.basename(from), "windows") || (await lstat(from)).isSymbolicLink());
        try {
          await cp(source, destination, {
            recursive: true,
            dereference: true,
            errorOnExist: true,
            force: false,
            filter: async (from) => {
              if (!(await skip(from))) return true;
              skipped += 1;
              return false;
            },
          });
        } catch (error) {
          // The destination did not exist before, so what is there is this copy's debris.
          await rm(destination, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
      } else if (info.isFile()) {
        const file = this.windowsTarget(await this.deps.dialogs.saveFile(windowId, name));
        if (file === undefined) return { ok: true, cancelled: true, skipped: 0 };
        await copyFile(source, file);
      } else {
        throw new Refused("EINVAL");
      }
      return { ok: true, cancelled: false, skipped };
    });
  }

  async reveal(raw: FileLocation): Promise<FileDoneResult> {
    return this.guard("reveal", async () => {
      const location = await this.checked(raw);
      const target = this.fsPath(location);
      await lstat(target);
      this.deps.shell.showItemInFolder(target);
      return { ok: true };
    });
  }

  async open(raw: FileLocation): Promise<FileDoneResult> {
    return this.guard("open", async () => {
      const location = await this.checked(raw);
      const target = this.fsPath(location);
      const info = await stat(target);
      if (!info.isFile() && !info.isDirectory()) throw new Refused("EINVAL");
      // What the system would run is not opened from here; a link is judged by its own name.
      if (info.isFile() && isProgramName(nameOf(location))) throw new Refused("EINVAL");
      // `openPath` answers with an error text; it may name the path, so it is not passed on.
      return (await this.deps.shell.openPath(target)) === "" ? { ok: true } : fail("OTHER");
    });
  }

  private fsPath(location: FileLocation): string {
    return toFsPath(location, this.deps.wslRoot);
  }

  /** Renames or moves without overwriting: an existing target is `EEXIST` (`fs.rename` would replace a file). */
  private async moveEntry(from: FileLocation, to: FileLocation): Promise<void> {
    const source = this.fsPath(from);
    const target = this.fsPath(to);
    const own = await lstat(source, { bigint: true });
    const there = await lstat(target, { bigint: true }).then(
      (info) => info,
      (error: unknown) => {
        if (codeOf(error) === "ENOENT") return undefined;
        throw error;
      },
    );
    // On a case-insensitive folder `a` to `A` finds the entry itself: that is a rename, not a clash.
    const itself = there !== undefined && there.ino !== 0n && there.ino === own.ino && there.dev === own.dev;
    if (there !== undefined && !(itself && source !== target)) throw new Refused("EEXIST");
    await rename(source, target);
  }

  private windowsTarget(chosen: string | undefined): string | undefined {
    if (chosen === undefined) return undefined;
    const checked = checkDialogPath(chosen);
    if (checked === undefined) throw new Refused("EINVAL");
    return checked;
  }

  /** The location with a normalized path; a WSL location needs a distro the core knows. */
  private async checked(raw: FileLocation): Promise<FileLocation> {
    const shape = checkLocation(raw);
    if (!shape) throw new Refused("EINVAL");
    if (shape.backend === "wsl" && !(await this.distroExists(shape.distro))) throw new Refused("EINVAL");
    return shape;
  }

  private async distroExists(distro: string): Promise<boolean> {
    const now = (this.deps.now ?? Date.now)();
    if (this.known) {
      const age = now - this.known.at;
      if (age < DISTRO_CACHE_MS && this.known.names.includes(distro)) return true;
      // An unknown name asks again at most every few seconds: `wsl.distros` runs `wsl.exe`.
      if (age < DISTRO_MISS_MS) return false;
    }
    this.known = { names: await this.deps.distros(), at: now };
    return this.known.names.includes(distro);
  }

  private async entryOf(
    dir: string,
    dirent: { name: string; isSymbolicLink(): boolean },
  ): Promise<FileEntry> {
    const full = `${dir.endsWith("\\") ? dir : `${dir}\\`}${dirent.name}`;
    try {
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        const target = await stat(full).then(
          (value) => (value.isDirectory() ? "directory" : value.isFile() ? "file" : undefined),
          () => undefined,
        );
        return {
          name: dirent.name,
          kind: "symlink",
          size: info.size,
          modified: info.mtimeMs,
          ...(target ? { targetKind: target } : {}),
        };
      }
      const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
      return { name: dirent.name, kind, size: kind === "file" ? info.size : 0, modified: info.mtimeMs };
    } catch {
      // The entry vanished or is not readable: it stays in the list, so the folder does not look emptier than it is.
      return { name: dirent.name, kind: dirent.isSymbolicLink() ? "symlink" : "other", size: 0, modified: 0 };
    }
  }

  private async guard<T extends { ok: boolean }>(
    operation: string,
    run: () => Promise<T>,
  ): Promise<T | FileFailure> {
    try {
      return await run();
    } catch (error) {
      const code = error instanceof Refused ? error.refusal : codeOf(error);
      this.deps.log?.(`files.${operation}: ${code}`);
      return fail(code);
    }
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (codeOf(error) === "ENOENT") return false;
    throw error;
  }
}

function compareNames(a: string, b: string): number {
  return (
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }) || (a < b ? -1 : a > b ? 1 : 0)
  );
}
