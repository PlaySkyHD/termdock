// The only place that uses electron-updater (#136): it reads `app-update.yml` of the package, finds the newest
// published release of PlaySkyHD/termdock on GitHub (drafts stay invisible), downloads in the background, checks the
// file against the SHA-512 of `latest.yml` and runs the NSIS installer. The app is unsigned (ADR 0007): without a
// `publisherName` in `app-update.yml` the updater checks no signature. Loaded on demand, only in the installed app.
import type { Logger } from "@termdock/core";
import type { UpdaterPort } from "./update-service.js";

export async function createElectronUpdater(logger: Logger): Promise<UpdaterPort> {
  const { default: electronUpdater } = await import("electron-updater");
  const { autoUpdater } = electronUpdater;
  autoUpdater.logger = {
    info: (message?: unknown) => logger.info(String(message)),
    warn: (message?: unknown) => logger.warn(String(message)),
    error: (message?: unknown) => logger.error(String(message)),
    debug: () => {},
  };
  autoUpdater.autoDownload = true;
  // A normal quit keeps the core with its Windows shells; an update on quit would end them without asking.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  return {
    check: async () => {
      // With `autoDownload` the result carries the download; its errors also come as the "error" event.
      const result = await autoUpdater.checkForUpdates();
      await result?.downloadPromise;
    },
    onDownloaded: (listener) => void autoUpdater.on("update-downloaded", (info) => listener(info.version)),
    onError: (listener) => void autoUpdater.on("error", (error) => listener(error)),
    // Silent, and the installer starts the new version afterwards (`--updated /S --force-run`).
    install: () => autoUpdater.quitAndInstall(true, true),
  };
}
