// Identity of the desktop app (ADR 0007), the same from the repo and in the installed package.
import path from "node:path";

/** `appId` of electron-builder.json; the installed app uses it as AppUserModelID (one taskbar icon). */
export const APP_USER_MODEL_ID = "io.github.playskyhd.termdock";

/**
 * Electron profile (`userData`) below `appData` (`%APPDATA%`): `@termdock\desktop` from the repo and in the
 * package alike. It also holds the single-instance lock, so an app from the repo and an installed app never run
 * two mains on one core. Set explicitly, so it does not follow a change of the npm name or `productName`.
 */
export function appUserDataDir(appData: string): string {
  return path.win32.join(appData, "@termdock", "desktop");
}
