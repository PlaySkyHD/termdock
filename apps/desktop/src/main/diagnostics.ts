// Diagnostic log of the desktop main process and the "Hilfe" menu entry that opens the log folder (spec diagnostics).
// The logger is the one of `@termdock/core`; the desktop writes `desktop.log` next to `core.log`.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createLogger, logDir } from "@termdock/core";
import type { Logger } from "@termdock/core";

export const DESKTOP_LOG_FILE = "desktop.log";
export const OPEN_LOG_FOLDER_LABEL = "Log-Ordner öffnen";

/** The logger of the main process: `<dataDir>/logs/desktop.log`, every line also on stderr. */
export function createDesktopLogger(
  dataDir: string | undefined,
  stderr: { write(text: string): unknown } = process.stderr,
): Logger {
  return createLogger({
    ...(dataDir === undefined ? {} : { file: path.join(logDir(dataDir), DESKTOP_LOG_FILE) }),
    source: "desktop",
    mirror: (_line, _level, _source, text) => void stderr.write(`termdock-desktop: ${text}\n`),
  });
}

export interface OpenLogFolderDeps {
  /** `shell.openPath`: resolves to an empty string on success, else to an error message. */
  openPath: (folder: string) => Promise<string>;
  /** Creates the folder when no log was written yet; defaults to `fs.mkdir` (recursive). */
  makeDir?: (folder: string) => Promise<unknown>;
  log: (text: string) => void;
}

/** Opens `<dataDir>/logs` in the file manager; a failure is logged and never thrown. */
export async function openLogFolder(dataDir: string, deps: OpenLogFolderDeps): Promise<void> {
  const folder = logDir(dataDir);
  try {
    await (deps.makeDir ?? ((dir) => mkdir(dir, { recursive: true })))(folder);
    const problem = await deps.openPath(folder);
    if (problem !== "") deps.log(`could not open the log folder ${folder}: ${problem}`);
  } catch (error) {
    deps.log(
      `could not open the log folder ${folder}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Waits for the logger to write what is queued, but at most `ms`; never rejects. Used before the app exits. */
export async function flushWithin(logger: Pick<Logger, "flush">, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)));
  try {
    await Promise.race([logger.flush().catch(() => {}), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The menu "Hilfe" with its one entry; `open` is called on a click. */
export function helpMenuTemplate(open: () => void): {
  label: string;
  submenu: { label: string; click: () => void }[];
} {
  return { label: "Hilfe", submenu: [{ label: OPEN_LOG_FOLDER_LABEL, click: open }] };
}
