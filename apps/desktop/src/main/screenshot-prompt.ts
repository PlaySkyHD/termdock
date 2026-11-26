// No user or host name in a picture (#191): the repository is public and `attach-screenshots.sh` publishes the
// screenshots. The default prompt of a shell names both (`user@host:~$`), so a scene types `NEUTRAL_PROMPT` first. Before
// every capture the run reads the rows of the terminals that the window shows and fails on a prompt that leaks.
import { setTimeout as sleep } from "node:timers/promises";
import type { DesktopBridge } from "./bridge.js";

/** What a scene types to get the short prompt `$ ` and a clean screen. */
export const NEUTRAL_PROMPT = "PS1='$ '; clear\r";

/**
 * Types the short prompt into the view that shows `sessionId` in the window (a hidden tab works too), then waits for
 * the shell to draw it. A scene calls this once per session it shows.
 */
export async function neutralPrompt(
  bridge: Pick<DesktopBridge, "viewsOf" | "sessionOf" | "call">,
  windowId: number,
  sessionId: string,
  data: string = NEUTRAL_PROMPT,
): Promise<void> {
  const viewId = bridge.viewsOf(windowId).find((each) => bridge.sessionOf(windowId, each) === sessionId);
  if (viewId === undefined)
    throw new Error(`neutralPrompt: session ${sessionId} has no view in window ${windowId}`);
  const result = await bridge.call(windowId, { method: "input", viewId, data });
  if (!result.ok) throw new Error(`neutralPrompt: input: ${result.error.message}`);
  await sleep(600);
}

/** The short prompt with the working directory, `<directory> $` (a scene that shows where the shell is). */
export const DIRECTORY_PROMPT = "PS1='\\w $ '; clear\r";

/**
 * Default prompt of a Linux shell (`user@host:`, also after a `(venv) ` prefix) and a path into a user profile of
 * Windows (`C:\Users\<name>`, `/mnt/c/Users/<name>`).
 */
const LEAK_PATTERNS: readonly RegExp[] = [
  /^\s*(\([^)]*\)\s*)?[^\s@]+@[^\s:]+:/,
  /[A-Za-z]:\\Users\\(?!Public\b)[^\\\s>]+/i,
  /\/mnt\/[a-z]\/Users\/(?!Public\b)[^/\s]+/i,
  // A path of the explorer panel (#202) in a home folder names the user; a prompt shows it as `~`.
  /^explorer: \/home\/[^/\s]+/,
];

/** Prefix of the rows `READ_VISIBLE_ROWS` reads from the explorer panel (#202), so only they meet its pattern. */
export const EXPLORER_ROW = "explorer: ";

/** The first row that names a user or host, or `undefined`. */
export function findPromptLeak(rows: readonly string[]): string | undefined {
  return rows
    .map((row) => row.replaceAll("\u00a0", " "))
    .find((row) => LEAK_PATTERNS.some((pattern) => pattern.test(row)));
}

/**
 * Throws when a row of the terminals in the picture `name` shows user or host name. The message names the row by
 * number, not by text: the log of a run can end up in a public issue.
 */
export function assertNoPromptLeak(name: string, rows: readonly string[]): void {
  const leak = findPromptLeak(rows);
  if (leak !== undefined)
    throw new Error(
      `${name}: the prompt shows user or host name (public repository): the scene must set the prompt neutral ` +
        `with NEUTRAL_PROMPT. Row ${rows.findIndex((row) => row.replaceAll("\u00a0", " ") === leak) + 1} of the visible terminals.`,
    );
}

/**
 * Reads the rows until none leaks, for at most `timeoutMs`: a shell that is still drawing the neutral prompt shows the
 * default one for a moment. Throws `assertNoPromptLeak`'s error with the last rows after that.
 */
export async function waitNoPromptLeak(
  name: string,
  readRows: () => Promise<readonly string[]>,
  timeoutMs = 5_000,
  pauseMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await readRows();
    if (findPromptLeak(rows) === undefined) return;
    if (Date.now() >= deadline) return assertNoPromptLeak(name, rows);
    await sleep(pauseMs);
  }
}

/**
 * JavaScript expression for the page: the text of every row of the terminals that are visible (a terminal of an
 * inactive tab is hidden and not in the picture), then the full path in the header of the explorer panel and its
 * rows (#202): the header shows the current directory of the shell, which can be a user profile.
 */
export const READ_VISIBLE_ROWS = `(() => {
  const rows = [];
  for (const area of document.querySelectorAll('.xterm-rows')) {
    if (!area.checkVisibility({ checkVisibilityCSS: true })) continue;
    for (const row of area.children) rows.push(row.textContent ?? '');
  }
  for (const panel of document.querySelectorAll('.explorer')) {
    if (!panel.checkVisibility({ checkVisibilityCSS: true })) continue;
    for (const path of panel.querySelectorAll('[data-explorer-path]'))
      rows.push('${EXPLORER_ROW}' + (path.dataset.explorerPath ?? ''));
    for (const row of panel.querySelectorAll('[data-path]')) rows.push('${EXPLORER_ROW}' + (row.dataset.path ?? ''));
  }
  return rows;
})()`;
