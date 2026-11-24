// Auto-update of the installed app (#136): when the main process may look for updates, and what the update dialog
// says. Pure, so the main process, the renderer and the tests share it. No Electron, no I/O. Which sessions survive
// an update is the rule of the quit dialog: WSL sessions live in tmux, Windows shells end with the core
// (`countActiveWindows` in quit-decision.ts).

/** The first check after the start: late enough not to slow the start down. */
export const UPDATE_FIRST_CHECK_MS = 30_000;
/** Then every 4 hours, for an app that runs for days. */
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** `app`: the normal start; the screenshot run and `--smoke-test` never look for updates. */
export type RunMode = "app" | "screenshot" | "smoke-test";

/** Only the installed app in its normal start: from the repo (`npm start`) there is nothing to update. */
export function updateChecksAllowed(input: { packaged: boolean; mode: RunMode }): boolean {
  return input.packaged && input.mode === "app";
}

/** The setting `checkForUpdates` (protocol 1.7): a missing key (a core 1.6, nothing stored) means on. */
export function checksEnabled(settings: { checkForUpdates?: boolean | undefined }): boolean {
  return settings.checkForUpdates !== false;
}

/** What a window offers: the version of the downloaded update, or none; `fromEvent` once an event has come. */
export interface UpdateOffer {
  version?: string;
  fromEvent: boolean;
}

export const NO_UPDATE_OFFER: UpdateOffer = { fromEvent: false };

/**
 * The offer after the answer of `updateState` (`state`, asked once when the page loads) or an `updateChanged`
 * event. An event is never older than an answer that arrives after it, so a late answer does not bring back an
 * offer that "Später" in another window has just hidden.
 */
export function nextUpdateOffer(
  offer: UpdateOffer,
  input: { kind: "state" | "event"; version?: string | undefined },
): UpdateOffer {
  if (input.kind === "state" && offer.fromEvent) return offer;
  const fromEvent = offer.fromEvent || input.kind === "event";
  return input.version === undefined ? { fromEvent } : { version: input.version, fromEvent };
}

/** The first sentence of the update dialog. */
export function updateMessage(version: string): string {
  return `Update auf Version ${version} ist bereit.`;
}

/** What the restart does to the sessions: WSL sessions keep running, Windows shells end with the core (#65). */
export function updateSessionsNote(windowsSessions: number): string {
  const start = "Der Neustart installiert das Update. WSL-Sessions laufen weiter, ";
  if (windowsSessions <= 0) return `${start}TermDock bindet sie danach wieder an.`;
  if (windowsSessions === 1) return `${start}die laufende Windows-Shell endet dabei.`;
  return `${start}die ${windowsSessions} laufenden Windows-Shells enden dabei.`;
}
