// Argument arrays for wsl.exe and tmux plus parsers for their output (ADR 0003, design add-wsl-backend).
import type { LaunchSpec, SessionId } from "@termdock/protocol";
import type { TerminalSnapshot } from "../types.js";

/** Distro and tmux socket a command runs against. */
export interface TmuxTarget {
  distro: string;
  socket: string;
}

/** Result of a wsl.exe call without PTY. `code` is null when the process did not exit normally. */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type PaneStatus = { dead: false } | { dead: true; exitCode?: number };

export interface DistroList {
  names: string[];
  defaultDistro: string | undefined;
}

const WORD = /^[A-Za-z0-9_-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PANE_STATUS_FORMAT = "#{pane_dead} #{pane_dead_status} #{pane_dead_signal}";
const CURSOR_FORMAT = "#{cursor_x} #{cursor_y} #{cursor_flag}";
const encoder = new TextEncoder();

/** tmux session name of a TermDock session. Only letters, digits, `-` and `_`, so no tmux target syntax gets in. */
export function sessionName(id: SessionId): string {
  if (!WORD.test(id)) throw new Error(`Invalid session id for tmux: ${JSON.stringify(id)}`);
  return `td-${id}`;
}

/** `wsl.exe` arguments that run `program` directly (no login shell) in `cwd`. */
export function wslExec(distro: string, cwd: string, program: readonly string[]): string[] {
  if (cwd === "") throw new Error("WSL working directory must not be empty");
  return ["-d", distro, "--cd", cwd, "--exec", ...program];
}

function tmux(target: TmuxTarget, cwd: string, args: readonly string[]): string[] {
  if (!WORD.test(target.socket))
    throw new Error(`Invalid tmux socket name: ${JSON.stringify(target.socket)}`);
  return wslExec(target.distro, cwd, ["tmux", "-L", target.socket, ...args]);
}

/** Exact session target (`=` prevents prefix matches such as td-1 → td-10). */
const sessionTarget = (name: string) => `=${name}`;
/** Pane target in the session; set-option, set-hook, capture-pane and display-message need this form. */
const paneTarget = (name: string) => `=${name}:`;

/**
 * tmux reads an argument ending in `;` as a command separator. It strips one backslash in front of that `;` and
 * passes the rest on literally (checked against tmux 3.6), so exactly one backslash is inserted.
 */
function tmuxLiteral(arg: string): string {
  return arg.endsWith(";") ? `${arg.slice(0, -1)}\\;` : arg;
}

function commandArgs(spec: LaunchSpec): string[] {
  const env: string[] = [];
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    if (!ENV_NAME.test(key)) throw new Error(`Invalid environment variable name: ${JSON.stringify(key)}`);
    env.push("-e", tmuxLiteral(`${key}=${value}`));
  }
  const command = (spec.command ?? []).map(tmuxLiteral);
  // tmux hands a single argument to `sh -c`; `env --` keeps it a plain program call.
  const program = command.length === 1 ? ["env", "--", ...command] : [...command];
  return [...env, ...program];
}

/** PTY command that creates (or joins) the session, without status line and with exit-code capture. */
export function startArgs(target: TmuxTarget, id: SessionId, spec: LaunchSpec): string[] {
  const name = sessionName(id);
  const pane = paneTarget(name);
  return tmux(target, spec.cwd, [
    "-T",
    "RGB",
    "new-session",
    "-A",
    "-s",
    name,
    ...commandArgs(spec),
    ";",
    "set-option",
    "-t",
    pane,
    "status",
    "off",
    ";",
    "set-option",
    "-w",
    "-t",
    pane,
    "remain-on-exit",
    "on",
    ";",
    "set-hook",
    "-t",
    pane,
    "pane-died",
    `detach-client -s ${sessionTarget(name)}`,
  ]);
}

/** PTY command that attaches a new client to an existing session. */
export function attachArgs(target: TmuxTarget, id: SessionId): string[] {
  // From ~ like has-session and kill-session: a vanished working directory must not break re-attaching.
  return tmux(target, "~", ["-T", "RGB", "attach-session", "-t", sessionTarget(sessionName(id))]);
}

export function hasSessionArgs(target: TmuxTarget, id: SessionId): string[] {
  return tmux(target, "~", ["has-session", "-t", sessionTarget(sessionName(id))]);
}

export function killSessionArgs(target: TmuxTarget, id: SessionId): string[] {
  return tmux(target, "~", ["kill-session", "-t", sessionTarget(sessionName(id))]);
}

/** `has-session` first: display-message does not fail for a missing target. */
export function paneStatusArgs(target: TmuxTarget, id: SessionId): string[] {
  const name = sessionName(id);
  return tmux(target, "~", [
    "has-session",
    "-t",
    sessionTarget(name),
    ";",
    "display-message",
    "-p",
    "-t",
    paneTarget(name),
    PANE_STATUS_FORMAT,
  ]);
}

/** Visible screen with colours, then the cursor position as the last line, in one wsl.exe call. */
export function snapshotArgs(target: TmuxTarget, id: SessionId): string[] {
  const name = sessionName(id);
  return tmux(target, "~", [
    "has-session",
    "-t",
    sessionTarget(name),
    ";",
    "capture-pane",
    "-p",
    "-e",
    "-J",
    "-t",
    paneTarget(name),
    ";",
    "display-message",
    "-p",
    "-t",
    paneTarget(name),
    CURSOR_FORMAT,
  ]);
}

export function versionArgs(distro: string): string[] {
  return wslExec(distro, "~", ["tmux", "-V"]);
}

export function keepaliveArgs(distro: string): string[] {
  return wslExec(distro, "~", ["sleep", "infinity"]);
}

export function listDistrosArgs(): string[] {
  return ["-l", "-v"];
}

/** tmux reported that the session or its server does not exist (as opposed to WSL failing). */
export function isMissingSession(result: RunResult): boolean {
  if (result.timedOut || result.code !== 1) return false;
  return /can't find session|no server running|error connecting to/.test(result.stderr);
}

/** Parses `#{pane_dead} #{pane_dead_status} #{pane_dead_signal}`; a signal maps to 128 + n like a shell. */
export function parsePaneStatus(stdout: string): PaneStatus {
  const [dead = "", status = "", signal = ""] = stdout.replace(/\r?\n$/, "").split(" ");
  if (dead !== "1") return { dead: false };
  if (/^\d+$/.test(status)) return { dead: true, exitCode: Number(status) };
  if (/^\d+$/.test(signal)) return { dead: true, exitCode: 128 + Number(signal) };
  return { dead: true };
}

/** Splits `capture-pane` output plus cursor line into a snapshot with CRLF line ends. */
export function parseSnapshot(stdout: string): TerminalSnapshot {
  const lines = stdout.replace(/\r?\n$/, "").split("\n");
  const position = /^(\d+) (\d+) ([01])$/.exec(lines.at(-1) ?? "");
  if (position) lines.pop();
  const screen = lines.join("\r\n");
  if (!position) return { data: encoder.encode(screen) };
  const x = Number(position[1]);
  const y = Number(position[2]);
  // Reset attributes so the colour of the last cell does not leak into later output, position the cursor
  // and restore its visibility (tmux reports a hidden cursor, e.g. htop).
  const visibility = position[3] === "1" ? "\x1b[?25h" : "\x1b[?25l";
  return { data: encoder.encode(`${screen}\x1b[0m\x1b[${y + 1};${x + 1}H${visibility}`), cursor: { x, y } };
}

/** Parses `wsl.exe -l -v`: header first, the default distro is marked with `*`. */
export function parseDistroList(stdout: string): DistroList {
  const lines = stdout
    .replace(/\0/g, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  const names: string[] = [];
  let defaultDistro: string | undefined;
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    const isDefault = trimmed.startsWith("*");
    const name = trimmed.replace(/^\*\s*/, "").split(/\s+/)[0];
    if (!name) continue;
    names.push(name);
    if (isDefault) defaultDistro = name;
  }
  return { names, defaultDistro: defaultDistro ?? names[0] };
}
