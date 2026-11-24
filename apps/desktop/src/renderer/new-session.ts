// The form "Neue Session" of the sidebar (#65): backend, Windows shell, name and working directory. Pure, no DOM; the
// core checks the request again.
import type { BackendKind, LaunchSpec, WindowsShell } from "@termdock/protocol";
import { pathProblem } from "./settings-form.js";

export interface NewSessionForm {
  name: string;
  backend: BackendKind;
  /** Windows only; empty: the default shell of the settings (or PowerShell 7, else Windows PowerShell). */
  shell: WindowsShell | "";
  /** Empty or `~`: the home directory (WSL in the distro, Windows the user folder). */
  cwd: string;
}

/** The name a new session gets until the user types one. */
export const DEFAULT_SESSION_NAMES: Readonly<Record<BackendKind, string>> = {
  wsl: "WSL",
  windows: "Windows",
};

export const SHELL_CHOICES: ReadonlyArray<{ value: WindowsShell | ""; label: string }> = [
  { value: "", label: "Standard aus den Einstellungen" },
  { value: "pwsh", label: "PowerShell 7 (pwsh)" },
  { value: "powershell", label: "Windows PowerShell" },
  { value: "cmd", label: "Eingabeaufforderung (cmd)" },
];

export const BACKEND_CHOICES: ReadonlyArray<{ value: BackendKind; label: string }> = [
  { value: "wsl", label: "WSL (tmux, überlebt den Core)" },
  { value: "windows", label: "Windows-Shell" },
];

export function emptyNewSession(): NewSessionForm {
  return { name: DEFAULT_SESSION_NAMES.wsl, backend: "wsl", shell: "", cwd: "~" };
}

/** The home directory (`~`) or a path below it, which both backends resolve themselves. */
function isHome(cwd: string): boolean {
  return cwd === "~" || cwd.startsWith("~/") || cwd.startsWith("~\\");
}

/**
 * The form after the backend changed: a name the user left at the default follows the backend, and a directory that
 * does not fit the new backend goes back to `~`.
 */
export function withBackend(form: NewSessionForm, backend: BackendKind): NewSessionForm {
  if (backend === form.backend) return form;
  const name = form.name === DEFAULT_SESSION_NAMES[form.backend] ? DEFAULT_SESSION_NAMES[backend] : form.name;
  const cwd = form.cwd.trim();
  const fits = cwd === "" || isHome(cwd) || pathProblem(cwd, backend) === undefined;
  return { ...form, backend, name, cwd: fits ? form.cwd : "~" };
}

/**
 * `session.create` from the form, or the message for the user. The name is trimmed and required. An empty directory
 * is `~`. A Windows directory must be `~`, a path below it, or a drive or UNC path; a WSL directory goes as typed, as
 * before (#65 changes nothing for WSL). The shell goes only for Windows and only when chosen.
 */
export function newSessionRequest(
  form: NewSessionForm,
): { ok: true; name: string; launch: LaunchSpec } | { ok: false; error: string } {
  const name = form.name.trim();
  if (name === "") return { ok: false, error: "Name fehlt" };
  const cwd = form.cwd.trim() === "" ? "~" : form.cwd.trim();
  if (form.backend === "windows" && !isHome(cwd)) {
    const problem = pathProblem(cwd, "windows");
    if (problem) return { ok: false, error: problem };
  }
  const launch: LaunchSpec = { backend: form.backend, cwd };
  if (form.backend === "windows" && form.shell !== "") launch.shell = form.shell;
  return { ok: true, name, launch };
}
