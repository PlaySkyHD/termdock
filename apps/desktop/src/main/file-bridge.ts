// Main side of the files channel (ADR 0009): parses the untrusted request of the renderer and calls the service.
// Free of Electron so it runs in tests. A request that does not fit the contract answers `EINVAL`, never throws.
import type { FileLocation, FileRequest } from "../shared/files.js";
import type { FileService } from "./file-service.js";

/** The service as the bridge needs it (`FileService` fits). */
export type FileOperations = Pick<
  FileService,
  "list" | "rename" | "move" | "delete" | "download" | "reveal" | "open"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The shape of a location; its content (path, distro) is checked by the service. */
function parseLocation(raw: unknown): FileLocation | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw["backend"] === "wsl" && typeof raw["distro"] === "string" && typeof raw["path"] === "string") {
    return { backend: "wsl", distro: raw["distro"], path: raw["path"] };
  }
  if (raw["backend"] === "windows" && typeof raw["path"] === "string") {
    return { backend: "windows", path: raw["path"] };
  }
  return undefined;
}

/** The request, or undefined when it is not one of the contract. Unknown fields are dropped. */
export function parseFileRequest(raw: unknown): FileRequest | undefined {
  if (!isRecord(raw)) return undefined;
  const location = parseLocation(raw["location"]);
  if (!location) return undefined;
  switch (raw["method"]) {
    case "list":
    case "delete":
    case "download":
    case "reveal":
    case "open":
      return { method: raw["method"], location };
    case "rename":
      return typeof raw["newName"] === "string"
        ? { method: "rename", location, newName: raw["newName"] }
        : undefined;
    case "move": {
      const targetDir = parseLocation(raw["targetDir"]);
      return targetDir ? { method: "move", location, targetDir } : undefined;
    }
    default:
      return undefined;
  }
}

export class FileBridge {
  constructor(private readonly files: FileOperations) {}

  /** `windowId` is the `webContents` id of the caller; the download dialog belongs to its window. */
  async call(windowId: number, raw: unknown): Promise<unknown> {
    const request = parseFileRequest(raw);
    if (!request) return { ok: false, code: "EINVAL" };
    switch (request.method) {
      case "list":
        return this.files.list(request.location);
      case "rename":
        return this.files.rename(request.location, request.newName);
      case "move":
        return this.files.move(request.location, request.targetDir);
      case "delete":
        return this.files.delete(request.location);
      case "download":
        return this.files.download(windowId, request.location);
      case "reveal":
        return this.files.reveal(request.location);
      case "open":
        return this.files.open(request.location);
    }
  }
}
