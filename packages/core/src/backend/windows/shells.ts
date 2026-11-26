// What the Windows backend runs (issue #65, ADR 0003): the shell or command, its directory and environment. Pure:
// the file system comes in as functions.
import path from "node:path";
import type { LaunchSpec, WindowsShell } from "@termdock/protocol";
import { isWindowsPath } from "../../workspace/paths.js";

/** Executable and base arguments of each shell; no profile script is skipped, the shell starts as in Windows Terminal. */
const SHELLS: Record<WindowsShell, { file: string; args: readonly string[]; label: string }> = {
  pwsh: { file: "pwsh.exe", args: ["-NoLogo"], label: "PowerShell 7" },
  powershell: { file: "powershell.exe", args: ["-NoLogo"], label: "Windows PowerShell" },
  cmd: { file: "cmd.exe", args: [], label: "Command Prompt" },
};

/**
 * Script of the prompt hook for PowerShell (#200), a constant without user input. It runs after the profile
 * (`-NoExit -Command`), wraps the `prompt` function the profile left and puts `ESC ] 9 ; 9 ; "<path>" ESC \` before
 * its text. Only the FileSystem provider reports a path. Every step is in `try`: a failing hook leaves the prompt
 * as it was, and the shell stays usable. No double quote appears in it (argument quoting of the process start).
 */
export const POWERSHELL_CWD_HOOK =
  "$global:__TermDockPrompt = $function:prompt; " +
  "function global:prompt { " +
  "$ok = $?; $text = $null; " +
  // The old prompt reads `$?` (posh-git, starship): hand it the status of the user's command, which `$ok` caught first.
  "try { if ($ok) { $text = & $global:__TermDockPrompt } else { Write-Error 'x' -ErrorAction Ignore; $text = & $global:__TermDockPrompt } } catch { }; " +
  "try { if ($text -and $PWD.Provider.Name -eq 'FileSystem') { " +
  "$e = [char]27; $q = [char]34; " +
  "$text = '' + $e + ']9;9;' + $q + $PWD.ProviderPath + $q + $e + '\\' + $text } } catch { }; " +
  "$text }";

/** `PROMPT` of `cmd` in front of the user's own (#200): `$e]9;9;$P$e\` is `ESC ] 9 ; 9 ; <current dir> ESC \`. */
export const CMD_CWD_HOOK = "$e]9;9;$P$e\\";

/** Prompt of `cmd` when `PROMPT` is not set. */
const CMD_DEFAULT_PROMPT = "$P$G";

export const WINDOWS_SHELLS = Object.keys(SHELLS) as WindowsShell[];

export function isWindowsShell(value: unknown): value is WindowsShell {
  return typeof value === "string" && Object.hasOwn(SHELLS, value);
}

/** What the lookups read: the environment and whether a path is a file. */
export interface ShellLookup {
  env: Readonly<Record<string, string | undefined>>;
  /** Whether a program file is there; an App Execution Alias (Store install) counts. May be slow on a share. */
  isFile(file: string): Promise<boolean>;
  /** Longest wait for one check; a slower one (hung network share in `PATH`) counts as absent. */
  timeoutMs: number;
}

/** The value of `name` in `env`, whatever its case (Windows names are case-insensitive, `Path` vs. `PATH`). */
export function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key.toUpperCase() === upper) return value;
  }
  return undefined;
}

/** The absolute directories of `PATH`; relative ones would resolve against the core's working directory. */
function pathDirs(env: ShellLookup["env"]): string[] {
  return (envValue(env, "PATH") ?? "")
    .split(";")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter((dir) => dir !== "" && isWindowsPath(dir));
}

/**
 * The first of `candidates` that is a file. All are checked at the same time and each for at most `timeoutMs`, so a
 * hung network share in `PATH` costs that long once and never blocks the core's main thread.
 */
async function firstFile(candidates: readonly string[], lookup: ShellLookup): Promise<string | undefined> {
  const found = await Promise.all(
    candidates.map((candidate) =>
      within(
        lookup.isFile(candidate).catch(() => false),
        lookup.timeoutMs,
      ),
    ),
  );
  const index = found.findIndex((each) => each === true);
  return index < 0 ? undefined : candidates[index];
}

/** Where `findShell` looks, in order: the known place of the shell, then each absolute `PATH` directory. */
export function shellCandidates(shell: WindowsShell, env: ShellLookup["env"]): string[] {
  const { file } = SHELLS[shell];
  const systemRoot = envValue(env, "SystemRoot");
  const programFiles = envValue(env, "ProgramFiles");
  const known: string[] = [];
  if (shell === "cmd" && systemRoot) known.push(path.win32.join(systemRoot, "System32", file));
  if (shell === "powershell" && systemRoot)
    known.push(path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", file));
  if (shell === "pwsh" && programFiles) known.push(path.win32.join(programFiles, "PowerShell", "7", file));
  return [...known, ...pathDirs(env).map((dir) => path.win32.join(dir, file))];
}

/**
 * Full path of the shell's executable, or undefined when it is not installed. Known places first (`System32` for
 * `powershell` and `cmd`, the PowerShell 7 folder for `pwsh`), then each absolute directory of `PATH` (a Store
 * install of PowerShell 7 lives there as an App Execution Alias).
 */
export function findShell(shell: WindowsShell, lookup: ShellLookup): Promise<string | undefined> {
  return firstFile(shellCandidates(shell, lookup.env), lookup);
}

/** Extensions CreateProcess runs itself; `.cmd` and `.bat` need `cmd.exe`. */
const RUNNABLE = [".exe", ".com"];
const BATCH = [".cmd", ".bat"];

/**
 * Full path of the program `launch.command[0]` names, as CreateProcess would run it: an absolute path as it is (or
 * with `.exe`), a bare name through the absolute `PATH` directories with `.exe` and `.com`. A relative path names no
 * program. When it is missing, the message says why, and for a batch file (`npm.cmd`) how to run it, since the core
 * never builds a shell string itself.
 */
export async function findProgram(
  program: string,
  lookup: ShellLookup,
): Promise<{ file: string } | { missing: string }> {
  const name = program.length > 64 ? `${program.slice(0, 64)}...` : program;
  const hasExtension = /\.[^\\/.]+$/.test(program);
  const forms = (base: string, extensions: readonly string[]): string[] =>
    hasExtension ? [base] : extensions.map((extension) => `${base}${extension}`);
  // CreateProcess runs a `.cmd`/`.bat` through cmd.exe, which parses the arguments again (`&calc` would run, BatBadBut):
  // a batch file is refused wherever it was found, also by absolute path.
  const batchMessage = (file: string): { missing: string } => {
    const shown = path.win32.basename(file);
    return {
      missing: `Program ${name} is a batch file (${shown}): run it as ["cmd.exe", "/d", "/c", "${shown}", ...]`,
    };
  };
  const isBatch = (file: string): boolean => BATCH.includes(path.win32.extname(file).toLowerCase());
  if (/[\\/]/.test(program)) {
    if (!isWindowsPath(program)) return { missing: `Program ${name} must be a name or an absolute path` };
    if (isBatch(program)) return batchMessage(program);
    const file = await firstFile(hasExtension ? [program] : [program, ...forms(program, RUNNABLE)], lookup);
    if (file === undefined) return { missing: `Program ${name} was not found` };
    return isBatch(file) ? batchMessage(file) : { file };
  }
  const dirs = pathDirs(lookup.env);
  const file = await firstFile(
    dirs.flatMap((dir) => forms(path.win32.join(dir, program), RUNNABLE)),
    lookup,
  );
  if (file !== undefined && !isBatch(file)) return { file };
  const batch =
    file ??
    (await firstFile(
      dirs.flatMap((dir) => forms(path.win32.join(dir, program), BATCH)),
      lookup,
    ));
  if (batch !== undefined) return batchMessage(batch);
  return { missing: `Program ${name} was not found in PATH` };
}

/** The value of `promise`, or undefined after `ms`; the timer does not outlive the race. */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The message when `shell` is not installed; it reaches the client, so it names the shell and the way out. */
export function shellMissingMessage(shell: WindowsShell): string {
  const { file, label } = SHELLS[shell];
  const others = WINDOWS_SHELLS.filter((other) => other !== shell).join(" or ");
  return `${label} (${file}) is not installed on this computer: install it or choose ${others}`;
}

/** The shell `resolveLaunch` pins when neither the spec nor the settings name one: PowerShell 7 if installed. */
export async function defaultShell(lookup: ShellLookup): Promise<WindowsShell> {
  return (await findShell("pwsh", lookup)) === undefined ? "powershell" : "pwsh";
}

/**
 * Program and argument array of a session: `launch.command` (its first entry is the program, found by `findProgram`,
 * run without a shell), else the shell with its own arguments. `error` when the program or shell is missing; its
 * text goes to the client. node-pty quotes each argument; no shell parses the command.
 */
export async function launchProgram(
  spec: Pick<LaunchSpec, "command">,
  shell: WindowsShell,
  lookup: ShellLookup,
): Promise<{ file: string; args: string[] } | { error: string }> {
  const command = spec.command ?? [];
  if (command.length > 0) {
    const found = await findProgram(command[0]!, lookup);
    return "missing" in found ? { error: found.missing } : { file: found.file, args: command.slice(1) };
  }
  const file = await findShell(shell, lookup);
  if (file === undefined) return { error: shellMissingMessage(shell) };
  // PowerShell gets the prompt hook as arguments; `cmd` gets it through `PROMPT` (`promptHookEnvironment`).
  const hook = shell === "cmd" ? [] : ["-NoExit", "-Command", POWERSHELL_CWD_HOOK];
  return { file, args: [...SHELLS[shell].args, ...hook] };
}

/**
 * Environment of a `cmd` shell with the prompt hook: `PROMPT` gets `CMD_CWD_HOOK` in front of the value in `env`
 * (`launch.env` included), or of the default `$P$G`. Any other shell, and every session with its own `command`,
 * keeps `env` as it is: the user's program is not touched.
 */
export function promptHookEnvironment(
  shell: WindowsShell,
  spec: Pick<LaunchSpec, "command">,
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  if (shell !== "cmd" || (spec.command ?? []).length > 0) return { ...env };
  const current = envValue(env, "PROMPT") ?? CMD_DEFAULT_PROMPT;
  const hooked: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (name.toUpperCase() !== "PROMPT") hooked[name] = value;
  hooked.PROMPT = `${CMD_CWD_HOOK}${current}`;
  return hooked;
}

/**
 * The directory `cwd` names: `~` is the home directory of the user, `~\dir` and `~/dir` lie below it, an absolute
 * Windows path stays. Anything else (a Linux path, a relative path) is undefined: it names no Windows directory.
 */
export function windowsCwd(cwd: string, home: string): string | undefined {
  if (cwd === "~") return home;
  if (cwd.startsWith("~\\") || cwd.startsWith("~/")) return path.win32.join(home, cwd.slice(2));
  return isWindowsPath(cwd) ? cwd : undefined;
}

/** Variables of the core that must not reach a shell: Electron would start every Electron app in it as Node. */
const CORE_ONLY_VARIABLES = new Set(["ELECTRON_RUN_AS_NODE"]);

/**
 * Whether a variable of the core stays out of a shell: `ELECTRON_RUN_AS_NODE`, and every `TERMDOCK_*` (pipe, data
 * folder, tmux socket of this core), so a TermDock started in the shell does not take over this core's pipe or data.
 */
function coreOnly(name: string): boolean {
  const upper = name.toUpperCase();
  return CORE_ONLY_VARIABLES.has(upper) || upper.startsWith("TERMDOCK_");
}

/**
 * Environment of a shell: the core's own without the core-only variables (`coreOnly`), then `extra` (`launch.env`). A
 * name of `extra` replaces the variable of the core whatever its case, so the block never holds `Path` and `PATH`
 * side by side.
 */
export function shellEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !coreOnly(name)) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra ?? {})) {
    for (const existing of Object.keys(env)) {
      if (existing.toUpperCase() === name.toUpperCase()) delete env[existing];
    }
    env[name] = value;
  }
  return env;
}
