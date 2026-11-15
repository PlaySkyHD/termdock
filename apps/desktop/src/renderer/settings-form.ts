// Form logic of the settings dialog (#64): what the fields show and what goes to the core. Pure, no DOM. The core
// checks every value again with its guards (and rejects secret-like env names); these checks give the user a
// message at the field before anything is sent.
import {
  MAX_HISTORY_LIMIT_BYTES,
  MAX_NAME_LENGTH,
  MAX_PATH_LENGTH,
  MIN_HISTORY_LIMIT_BYTES,
} from "@termdock/protocol";
import type {
  BackendKind,
  LaunchProfile,
  LaunchSpec,
  ProfileCreateParams,
  Settings,
  SettingsPatch,
  WindowsShell,
} from "@termdock/protocol";
import type { ProfileChange } from "../shared/bridge.js";

/** `launch.cwd` of a profile that takes the default directory (core: `PROFILE_DEFAULT_CWD`). */
export const DEFAULT_PROFILE_CWD = "~";
const MIB = 1024 * 1024;

// --- Fields ---------------------------------------------------------------------------------------

/** One argument per line; empty lines drop out. A line is never split at spaces: no shell parses it. */
export function parseArgumentList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "");
}

export function formatArgumentList(args: readonly string[] | undefined): string {
  return (args ?? []).join("\n");
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `NAME=value` per line; the value may hold `=` and spaces. Empty lines drop out. */
export function parseEnv(text: string): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const index = line.indexOf("=");
    const name = index < 0 ? line.trim() : line.slice(0, index).trim();
    if (index < 0) return { error: `„${shorten(name)}“: Format NAME=Wert` };
    if (!ENV_NAME.test(name)) return { error: `„${shorten(name)}“ ist kein gültiger Variablenname` };
    if (Object.hasOwn(env, name)) return { error: `„${name}“ steht mehrfach da` };
    env[name] = line.slice(index + 1);
  }
  return { env };
}

export function formatEnv(env: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(env ?? {})
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
}

/** Drive path (`C:\dir`, `C:/dir`) or UNC path (`\\server\share`), as the core's project check. */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/;

/** Why `path` does not fit `backend` (absolute Linux path for WSL, drive or UNC path for Windows), or undefined. */
export function pathProblem(path: string, backend: BackendKind): string | undefined {
  if (path.length > MAX_PATH_LENGTH) return `Höchstens ${MAX_PATH_LENGTH} Zeichen`;
  if (path.includes("\u0000")) return "Das Verzeichnis enthält ein Nullzeichen";
  if (backend === "wsl")
    return path.startsWith("/") ? undefined : "Für WSL ein absoluter Linux-Pfad, etwa /home/dev/app";
  return WINDOWS_PATH.test(path) ? undefined : "Für Windows ein Pfad wie C:\\dev oder \\\\server\\freigabe";
}

function nameProblem(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "") return "Name fehlt";
  if (trimmed.length > MAX_NAME_LENGTH) return `Höchstens ${MAX_NAME_LENGTH} Zeichen`;
  return undefined;
}

function shorten(text: string): string {
  return text.length > 32 ? `${text.slice(0, 32)}…` : text;
}

// --- Launch profiles -------------------------------------------------------------------------------

export interface ProfileForm {
  name: string;
  backend: BackendKind;
  /** WSL only; empty means the default distro of the settings or WSL. */
  distro: string;
  /** Windows only; empty means the default shell. */
  shell: WindowsShell | "";
  /** Empty or `~`: the default directory (project, workspace, settings). */
  cwd: string;
  /** One argument per line; empty: the login shell. */
  command: string;
  /** `NAME=value` per line. */
  env: string;
  autostart: boolean;
  loggingEnabled: boolean;
}

export type ProfileField = "name" | "distro" | "cwd" | "command" | "env";
export type ProfileErrors = Partial<Record<ProfileField, string>>;

export function emptyProfileForm(loggingEnabled: boolean): ProfileForm {
  return {
    name: "",
    backend: "wsl",
    distro: "",
    shell: "",
    cwd: "",
    command: "",
    env: "",
    autostart: false,
    loggingEnabled,
  };
}

export function profileToForm(profile: LaunchProfile): ProfileForm {
  const { launch } = profile;
  return {
    name: profile.name,
    backend: launch.backend,
    distro: launch.distro ?? "",
    shell: launch.shell ?? "",
    cwd: launch.cwd === DEFAULT_PROFILE_CWD ? "" : launch.cwd,
    command: formatArgumentList(launch.command),
    env: formatEnv(launch.env),
    autostart: profile.autostart,
    loggingEnabled: profile.loggingEnabled,
  };
}

type Checked = { ok: true; name: string; launch: LaunchSpec } | { ok: false; errors: ProfileErrors };

/**
 * Checks the form and builds the launch spec. With `original` (editing), a directory, command or environment whose
 * text the user left untouched keeps the stored value as it is: the fields cannot show every stored value losslessly
 * (an argument with a line break, an empty argument, a value with a line break, a directory like `~/work` that
 * another client stored), and saving another change must not rewrite them.
 */
function checkProfile(form: ProfileForm, original?: LaunchProfile): Checked {
  const shown = original && original.launch.backend === form.backend ? profileToForm(original) : undefined;
  const kept = shown && original ? original.launch : undefined;
  const errors: ProfileErrors = {};
  const name = nameProblem(form.name);
  if (name) errors.name = name;
  const distro = form.distro.trim();
  if (form.backend === "wsl" && distro.length > MAX_NAME_LENGTH)
    errors.distro = `Höchstens ${MAX_NAME_LENGTH} Zeichen`;
  let cwd = form.cwd.trim() === "" ? DEFAULT_PROFILE_CWD : form.cwd.trim();
  if (kept && form.cwd === shown?.cwd) cwd = kept.cwd;
  else if (cwd !== DEFAULT_PROFILE_CWD) {
    const problem = pathProblem(cwd, form.backend);
    if (problem) errors.cwd = problem;
  }
  let env: Readonly<Record<string, string>> | undefined;
  if (kept && form.env === shown?.env) env = kept.env;
  else {
    const parsed = parseEnv(form.env);
    if ("error" in parsed) errors.env = parsed.error;
    else if (Object.keys(parsed.env).length > 0) env = parsed.env;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const launch: LaunchSpec = { backend: form.backend, cwd };
  if (form.backend === "wsl" && distro !== "") launch.distro = distro;
  if (form.backend === "windows" && form.shell !== "") launch.shell = form.shell;
  const command = kept && form.command === shown?.command ? kept.command : parseArgumentList(form.command);
  if (command !== undefined && command.length > 0) launch.command = command;
  if (env !== undefined && Object.keys(env).length > 0) launch.env = env;
  return { ok: true, name: form.name.trim(), launch };
}

/** `profile.create` from the form, or the messages per field. Workspace and project stay unbound. */
export function profileCreateParams(
  form: ProfileForm,
): { ok: true; params: ProfileCreateParams } | { ok: false; errors: ProfileErrors } {
  const checked = checkProfile(form);
  if (!checked.ok) return checked;
  return {
    ok: true,
    params: {
      name: checked.name,
      launch: checked.launch,
      autostart: form.autostart,
      loggingEnabled: form.loggingEnabled,
    },
  };
}

/**
 * The fields of `profile.update` that differ from `profile`: the launch spec goes as a whole, workspace and project
 * are never touched. An empty change means nothing to send.
 */
export function profileChange(
  profile: LaunchProfile,
  form: ProfileForm,
): { ok: true; change: ProfileChange } | { ok: false; errors: ProfileErrors } {
  const checked = checkProfile(form, profile);
  if (!checked.ok) return checked;
  const change: ProfileChange = {};
  if (checked.name !== profile.name) change.name = checked.name;
  if (!sameLaunch(checked.launch, profile.launch)) change.launch = checked.launch;
  if (form.autostart !== profile.autostart) change.autostart = form.autostart;
  if (form.loggingEnabled !== profile.loggingEnabled) change.loggingEnabled = form.loggingEnabled;
  return { ok: true, change };
}

function sameLaunch(a: LaunchSpec, b: LaunchSpec): boolean {
  return (
    a.backend === b.backend &&
    a.cwd === b.cwd &&
    a.distro === b.distro &&
    a.shell === b.shell &&
    JSON.stringify(a.command ?? []) === JSON.stringify(b.command ?? []) &&
    formatEnv(a.env) === formatEnv(b.env)
  );
}

// --- Section "Allgemein" ---------------------------------------------------------------------------

export interface GeneralForm {
  /** Empty: the WSL default. */
  distro: string;
  shell: WindowsShell | "";
  /** Empty: none. */
  cwd: string;
  /** `confirmQuitWhileRunning`. */
  confirmQuit: boolean;
}

export type GeneralErrors = Partial<Record<"distro" | "cwd", string>>;

export function generalForm(settings: Settings): GeneralForm {
  return {
    distro: settings.defaultDistro ?? "",
    shell: settings.defaultShell ?? "",
    cwd: settings.defaultCwd ?? "",
    confirmQuit: settings.confirmQuitWhileRunning,
  };
}

/** The changed keys of the section; an emptied field removes its key (`null`). */
export function generalPatch(
  settings: Settings,
  form: GeneralForm,
): { ok: true; patch: SettingsPatch } | { ok: false; errors: GeneralErrors } {
  const errors: GeneralErrors = {};
  const distro = form.distro.trim();
  const cwd = form.cwd.trim();
  if (distro.length > MAX_NAME_LENGTH) errors.distro = `Höchstens ${MAX_NAME_LENGTH} Zeichen`;
  // The default directory serves both backends; `defaultCwd` of the core uses it where its syntax fits.
  if (cwd !== "" && pathProblem(cwd, "wsl") !== undefined && pathProblem(cwd, "windows") !== undefined)
    errors.cwd = "Ein absoluter Linux-Pfad (/home/dev) oder ein Windows-Pfad (C:\\dev)";
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const patch: SettingsPatch = {};
  if (distro !== (settings.defaultDistro ?? "")) patch.defaultDistro = distro === "" ? null : distro;
  if (form.shell !== (settings.defaultShell ?? ""))
    patch.defaultShell = form.shell === "" ? null : form.shell;
  if (cwd !== (settings.defaultCwd ?? "")) patch.defaultCwd = cwd === "" ? null : cwd;
  if (form.confirmQuit !== settings.confirmQuitWhileRunning) patch.confirmQuitWhileRunning = form.confirmQuit;
  return { ok: true, patch };
}

// --- Section "Verlauf" -----------------------------------------------------------------------------

export interface HistoryForm {
  /** Limit per session in MiB, `.` or `,` as decimal mark. */
  limitMiB: string;
  enabledByDefault: boolean;
}

/** Bytes as MiB without trailing zeros (at most 4 decimals). */
export function formatMiB(bytes: number): string {
  return String(Math.round((bytes / MIB) * 10_000) / 10_000);
}

export function historyForm(settings: Settings): HistoryForm {
  return {
    limitMiB: formatMiB(settings.historyLimitBytes),
    enabledByDefault: settings.historyEnabledByDefault,
  };
}

export function historyPatch(
  settings: Settings,
  form: HistoryForm,
): { ok: true; patch: SettingsPatch } | { ok: false; errors: { limit?: string } } {
  const patch: SettingsPatch = {};
  if (form.enabledByDefault !== settings.historyEnabledByDefault)
    patch.historyEnabledByDefault = form.enabledByDefault;
  // An untouched limit stays: MiB with 4 decimals do not give every stored byte count back.
  if (form.limitMiB.trim() === formatMiB(settings.historyLimitBytes)) return { ok: true, patch };
  const text = form.limitMiB.trim().replace(",", ".");
  const mib = /^\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
  const bytes = Math.round(mib * MIB);
  if (!Number.isFinite(mib) || bytes < MIN_HISTORY_LIMIT_BYTES || bytes > MAX_HISTORY_LIMIT_BYTES) {
    return {
      ok: false,
      errors: {
        limit: `Eine Zahl von ${formatMiB(MIN_HISTORY_LIMIT_BYTES)} bis ${formatMiB(MAX_HISTORY_LIMIT_BYTES)} MiB`,
      },
    };
  }
  if (bytes !== settings.historyLimitBytes) patch.historyLimitBytes = bytes;
  return { ok: true, patch };
}

// --- New settings while a section is open (settings.changed) -----------------------------------------

/** Each field of `form` that still shows `from` takes the value of `to`; a field the user changed stays. */
function rebase<F extends object>(form: F, from: F, to: F): F {
  const result = { ...form };
  for (const key of Object.keys(form) as (keyof F)[]) {
    if (form[key] === from[key]) result[key] = to[key];
  }
  return result;
}

/**
 * The general form after `settings.changed`: untouched fields show the new values, typed ones stay. The caller then
 * builds patches against `newBase`, so setting a field back to its old value reaches the core.
 */
export function rebaseGeneral(form: GeneralForm, oldBase: Settings, newBase: Settings): GeneralForm {
  return rebase(form, generalForm(oldBase), generalForm(newBase));
}

export function rebaseHistory(form: HistoryForm, oldBase: Settings, newBase: Settings): HistoryForm {
  return rebase(form, historyForm(oldBase), historyForm(newBase));
}
