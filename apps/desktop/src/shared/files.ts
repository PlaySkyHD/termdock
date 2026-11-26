// Contract of the file access between renderer, preload and main (ADR 0009). Types and constants only: the
// sandboxed preload cannot load local modules.

/** `ipcRenderer.invoke` channel for every call of the file access (own channel next to `CALL_CHANNEL`). */
export const FILES_CHANNEL = "termdock:files";

/** Longest path of a location, like every other path of the app (`MAX_PATH_LENGTH` of the protocol). */
export const MAX_FILE_PATH_LENGTH = 512;
/** Longest name of one entry (bytes in UTF-8, the limit of the file systems). */
export const MAX_FILE_NAME_BYTES = 255;
/** A listing returns at most this many entries and says so with `truncated`. */
export const MAX_LIST_ENTRIES = 5000;

/** Where a file lives: a Linux path inside a WSL distro, or a Windows path with drive letter. */
export type FileLocation =
  { backend: "wsl"; distro: string; path: string } | { backend: "windows"; path: string };

export type FileErrorCode = "ENOENT" | "EACCES" | "EEXIST" | "EINVAL" | "OTHER";

/** Every operation answers with a result; nothing throws across the bridge. */
export interface FileFailure {
  ok: false;
  code: FileErrorCode;
}

export type FileEntryKind = "file" | "directory" | "symlink" | "other";

export interface FileEntry {
  name: string;
  kind: FileEntryKind;
  /** Bytes; 0 for folders and when the entry could not be read. */
  size: number;
  /** Milliseconds since 1970; 0 when the entry could not be read. */
  modified: number;
  /** For a symlink: what it points to; absent when the target is missing or not readable. */
  targetKind?: "file" | "directory";
}

export type FileListResult =
  | {
      ok: true;
      /** Folders first, then by name; at most `MAX_LIST_ENTRIES`. */
      entries: FileEntry[];
      /** True when the folder has more entries than returned. */
      truncated: boolean;
      /** Number of entries in the folder. */
      total: number;
    }
  | FileFailure;

export type FileDoneResult = { ok: true } | FileFailure;
/** The new location of a renamed or moved entry. */
export type FileMovedResult = { ok: true; location: FileLocation } | FileFailure;
/**
 * `cancelled`: the user closed the dialog; nothing was copied. `skipped`: entries of a folder that were not copied
 * (symlinks and names Windows cannot hold); a skipped folder counts once.
 */
export type FileDownloadResult = { ok: true; cancelled: boolean; skipped: number } | FileFailure;

/** What the preload exposes as `window.termdock.files`. */
export interface FilesApi {
  /** Lists a folder (not recursive). */
  list(location: FileLocation): Promise<FileListResult>;
  /** Renames within the same folder; `newName` is a name, never a path. */
  rename(location: FileLocation, newName: string): Promise<FileMovedResult>;
  /** Moves into `targetDir` of the same backend (and distro) under the same name; never overwrites (`EEXIST`). */
  move(location: FileLocation, targetDir: FileLocation): Promise<FileMovedResult>;
  /** Deletes for good, folders recursively. The confirmation is the renderer's job. */
  delete(location: FileLocation): Promise<FileDoneResult>;
  /** Copies a WSL file or folder to Windows; the main process asks for the target in a dialog. */
  download(location: FileLocation): Promise<FileDownloadResult>;
  /** Shows the entry in the Windows Explorer. */
  reveal(location: FileLocation): Promise<FileDoneResult>;
  /** Opens the entry with the program Windows associates with it; programs and scripts are refused (`EINVAL`). */
  open(location: FileLocation): Promise<FileDoneResult>;
}

/** The only calls of `FILES_CHANNEL`. Anything else answers `EINVAL`. */
export type FileRequest =
  | { method: "list"; location: FileLocation }
  | { method: "rename"; location: FileLocation; newName: string }
  | { method: "move"; location: FileLocation; targetDir: FileLocation }
  | { method: "delete"; location: FileLocation }
  | { method: "download"; location: FileLocation }
  | { method: "reveal"; location: FileLocation }
  | { method: "open"; location: FileLocation };
