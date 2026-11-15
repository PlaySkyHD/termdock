// Scenes of the screenshot mode for the settings dialog (#64): Ctrl+, opens it, every section is captured, the
// question on quit is turned back on, the history limit changes, a launch profile is created through the editor and
// one with a secret-like env name is refused by the core (the message stays in the dialog). Each change is checked in
// the isolated core; any other outcome ends the run with an error (exit code 1). Needs Electron and the isolated
// core; no unit test (the pieces are tested: form logic, bridge, core).
import { mkdirSync } from "node:fs";
import type { LaunchProfile, Settings } from "@termdock/protocol";
import type { ScenarioDeps } from "./screenshot-scenario.js";
import { pageDriver } from "./screenshot-page.js";

// All sections stay mounted (hidden when not shown): every selector names its section.
const GENERAL = '[data-settings-form="general"]';
const HISTORY = '[data-settings-form="history"]';
const EDITOR = '[data-settings-form="profile-editor"]';

export async function settingsScenes(deps: ScenarioDeps): Promise<void> {
  const { dir, bridge, core, createWindow, log } = deps;
  mkdirSync(dir, { recursive: true });
  const win = createWindow(1100, 720);
  const windowId = win.webContents.id;
  // Windows of earlier scenes lie below; a covered window stops painting.
  win.webContents.setBackgroundThrottling(false);
  win.show();
  win.moveTop();
  win.focus();
  const { evaluate, waitFor, capture, click, fill, key } = pageDriver(win, dir);

  const settings = async (): Promise<Settings> => (await core.request("settings.get", {})).result.settings;
  const profiles = async (): Promise<LaunchProfile[]> =>
    (await core.request("profile.list", {})).result.profiles;
  /** Sets a select or text area the way React hears it (`fill` covers inputs). */
  const setValue = async (selector: string, value: string): Promise<void> => {
    await waitFor(`document.querySelector(${JSON.stringify(selector)})`, selector);
    await evaluate(`(() => {
      const field = document.querySelector(${JSON.stringify(selector)});
      const proto = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, ${JSON.stringify(value)});
      field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    })()`);
  };
  const exists = (selector: string): string => `document.querySelector(${JSON.stringify(selector)})`;
  const dialog = exists('[data-dialog="settings"]');
  const inSection = (section: string): string =>
    exists(`[data-dialog="settings"][data-settings-section="${section}"]`);
  const openTab = async (section: string): Promise<void> => {
    await click(`[data-settings-tab="${section}"]`);
    await waitFor(inSection(section), `the section ${section}`);
  };

  // The quit question was answered with "do not ask again" before: the dialog turns it back on.
  const stored = await bridge.call(windowId, {
    method: "updateSettings",
    settings: { confirmQuitWhileRunning: false, quitAction: "keepSessions" },
  });
  if (!stored.ok) throw new Error(`updateSettings: ${stored.error.message}`);
  await waitFor(`document.querySelector('.app') && !document.querySelector('.app--loading')`, "the window");

  // --- Ctrl+, opens the dialog on "Allgemein", the focus inside -----------------------------------------
  win.focus();
  await key(",", ["control"]);
  await waitFor(inSection("general"), "the settings dialog on Allgemein");
  await waitFor(exists(GENERAL), "the general form");
  await waitFor(
    `${exists(`${GENERAL} [data-field="distro"] option:nth-child(2)`)} || ${exists(`${GENERAL} [data-settings="distro-unavailable"]`)}`,
    "the WSL list or its reason",
  );
  const focusInside = await evaluate<boolean>(
    `Boolean(document.activeElement && document.activeElement.closest('[data-dialog="settings"]'))`,
  );
  if (!focusInside) throw new Error("The settings dialog does not hold the focus");
  await capture("60-settings-general.png");

  await click(`${GENERAL} [data-field="confirmQuit"]`);
  await click(`${GENERAL} [data-settings-action="save"]`);
  await waitFor(exists(`${GENERAL} [data-settings="saved"]`), "the general section to save");
  const afterGeneral = await settings();
  if (!afterGeneral.confirmQuitWhileRunning) throw new Error("Beim Schließen fragen did not reach the core");
  log("settings: the quit question is on again");

  // --- Verlauf: the limit in MiB --------------------------------------------------------------------------
  await openTab("history");
  await fill(`${HISTORY} [data-field="limit"]`, "2048");
  await click(`${HISTORY} [data-settings-action="save"]`);
  await waitFor(exists(`${HISTORY} [data-field-error]`), "the message of an invalid limit");
  if ((await settings()).historyLimitBytes !== afterGeneral.historyLimitBytes)
    throw new Error("An invalid limit reached the core");
  await fill(`${HISTORY} [data-field="limit"]`, "20");
  await click(`${HISTORY} [data-settings-action="save"]`);
  await waitFor(exists(`${HISTORY} [data-settings="saved"]`), "the history section to save");
  if ((await settings()).historyLimitBytes !== 20 * 1024 * 1024)
    throw new Error("The history limit of 20 MiB did not reach the core");
  await capture("61-settings-history.png");

  // --- Kürzel: the overview, read only ----------------------------------------------------------------------
  await openTab("shortcuts");
  await waitFor(
    exists('[data-settings-form="shortcuts"] [data-command="openSettings"]'),
    "the row of the settings key",
  );
  if (await evaluate<boolean>(`Boolean(${exists('[data-settings-form="shortcuts"] input')})`))
    throw new Error("The overview of the keys must not have fields");
  await capture("62-settings-shortcuts.png");

  // --- Startprofile: editor, list -------------------------------------------------------------------------
  await openTab("profiles");
  const before = (await profiles()).length;
  await click('[data-profile-action="new"]');
  await waitFor(exists(EDITOR), "the profile editor");
  await fill(`${EDITOR} [data-field="name"]`, "Claude");
  await fill(`${EDITOR} [data-field="cwd"]`, "/srv/app");
  await setValue(`${EDITOR} [data-field="command"]`, "claude\n--continue");
  await setValue(`${EDITOR} [data-field="env"]`, "LANG=de_DE.UTF-8");
  await click(`${EDITOR} [data-field="autostart"]`);
  await capture("63-settings-profile-editor.png");
  await click(`${EDITOR} [data-settings-action="save"]`);
  await waitFor(exists('[data-profile-name="Claude"]'), "the new profile in the list");
  const created = (await profiles()).find((profile) => profile.name === "Claude");
  if (
    !created ||
    JSON.stringify(created.launch.command) !== JSON.stringify(["claude", "--continue"]) ||
    !created.autostart ||
    created.launch.cwd !== "/srv/app"
  )
    throw new Error(`The profile did not reach the core as typed: ${JSON.stringify(created)}`);
  // A second profile from another client: the open list takes it from `profile.changed`.
  const other = await core.request("profile.create", {
    name: "Server-Logs",
    launch: { backend: "wsl", cwd: "/var/log", command: ["tail", "-f", "syslog"] },
  });
  await waitFor(
    exists(`[data-profile-name=${JSON.stringify(other.result.profile.name)}]`),
    "the profile of another client in the list",
  );
  await capture("64-settings-profiles-list.png");
  log("settings: profile created through the editor and listed");

  // --- The core refuses a secret-like env name; the message stays in the dialog ---------------------------
  await click('[data-profile-action="new"]');
  await waitFor(exists(EDITOR), "the profile editor again");
  await fill(`${EDITOR} [data-field="name"]`, "Deploy");
  await setValue(`${EDITOR} [data-field="command"]`, "deploy");
  await setValue(`${EDITOR} [data-field="env"]`, "API_TOKEN=beispiel");
  await click(`${EDITOR} [data-settings-action="save"]`);
  await waitFor(exists(`${EDITOR} [data-settings="error"]`), "the refusal of the core");
  const message = await evaluate<string>(`${exists(`${EDITOR} [data-settings="error"]`)}.textContent`);
  if (!/secret/i.test(message)) throw new Error(`Unexpected refusal: ${message}`);
  const values = await evaluate<{ name: string; env: string }>(
    `({ name: ${exists(`${EDITOR} [data-field="name"]`)}.value, env: ${exists(`${EDITOR} [data-field="env"]`)}.value })`,
  );
  if (values.name !== "Deploy" || values.env !== "API_TOKEN=beispiel")
    throw new Error(`The editor lost its input: ${JSON.stringify(values)}`);
  if ((await profiles()).length !== before + 2) throw new Error("The refused profile was stored");
  // The message must be in the visible part of the scrolling panel, not below it (PR #115).
  await waitFor(
    `(() => {
      const error = ${exists(`${EDITOR} [data-settings="error"]`)}.getBoundingClientRect();
      const panel = document.querySelector('.settings__panel').getBoundingClientRect();
      return error.top >= panel.top && error.bottom <= panel.bottom;
    })()`,
    "the refusal to be visible in the panel",
    5_000,
  );
  await capture("65-settings-profile-error.png");
  log("settings: the core refused the secret-like env name");

  // --- Escape: first back to the list, then the dialog closes; the menu entry opens it again ------------------
  await key("Escape");
  await waitFor(`!${exists(EDITOR)} && ${dialog}`, "Escape to close the editor, not the dialog");
  await key("Escape");
  await waitFor(`!${dialog}`, "the dialog to close on the second Escape");
  if (!bridge.sendTo(windowId, { kind: "openSettings" })) throw new Error("The window is gone");
  await waitFor(inSection("general"), "the dialog from the menu entry");
  await key("Escape");
  await waitFor(`!${dialog}`, "the dialog to close again");
  log("settings scenes done");
}
