// Phase-0-PoC: prüft WSL-tmux-Reattach ohne Electron.
//
// Ablauf: node-pty startet tmux in WSL, schreibt `echo marker-123`, beendet die PTY,
// prüft per `has-session`, dass die Session weiterlebt, hängt mit einer neuen PTY an,
// prüft per `capture-pane -p -J`, dass `marker-123` sichtbar ist, und räumt mit
// `kill-session` auf. Zusätzlich: Resize (`stty size`/`tput cols`) und Farbsequenzen.
//
// Aufruf: node scripts/reattach-check.mjs [--idle <sekunden> [--keepalive]] [--dash-dash] [--no-conpty-dll]
//   --idle:          wartet nach dem Beenden der PTY so lange ohne wsl.exe-Prozess dieses
//                    Skripts, bevor has-session geprüft wird (beendet WSL die Distro samt tmux?).
//   --keepalive:     hält während --idle einen `wsl.exe ... sleep infinity` ohne PTY offen.
//   --dash-dash:     startet wie im Issue mit `wsl.exe ... -- tmux` statt `--exec tmux`.
//   --no-conpty-dll: nutzt die ConPTY des Systems statt der mit node-pty gelieferten conpty.dll.

import { execFile, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import pty from "node-pty";

const DISTRO = "Ubuntu";
const SOCKET = "termdock-poc";
const SESSION = "td-poc-check";
const MARKER = "marker-123";

const idleIndex = process.argv.indexOf("--idle");
const idleSeconds = idleIndex > 0 ? Number(process.argv[idleIndex + 1]) : 0;
// `wsl.exe -- <args>` reicht die Argumente an die Login-Shell der Distro weiter ($HOME, `;`
// usw. werden interpretiert). `--exec` startet das Programm ohne Shell.
const WSL_RUN = process.argv.includes("--dash-dash") ? "--" : "--exec";
const USE_CONPTY_DLL = !process.argv.includes("--no-conpty-dll");
const KEEPALIVE = process.argv.includes("--keepalive");
const KEEPALIVE_PROCS = [];

const results = [];
const openPtys = new Set();

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function wslArgs(tmuxArgs) {
  return ["-d", DISTRO, "--cd", "~", WSL_RUN, "tmux", "-L", SOCKET, ...tmuxArgs];
}

function wsl(args) {
  return new Promise((resolve) => {
    execFile(
      "wsl.exe",
      args,
      { env: { ...process.env, WSL_UTF8: "1" }, timeout: 15000, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
      },
    );
  });
}

function tmux(tmuxArgs) {
  return wsl(wslArgs(tmuxArgs));
}

function spawnTmux(tmuxArgs, cols = 100, rows = 30) {
  const term = pty.spawn("wsl.exe", wslArgs(tmuxArgs), {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.env.USERPROFILE ?? process.cwd(),
    env: process.env,
    useConptyDll: USE_CONPTY_DLL,
  });
  const state = { term, output: "", exited: false, firstDataAt: 0 };
  const startedAt = Date.now();
  term.onData((data) => {
    if (!state.firstDataAt) state.firstDataAt = Date.now() - startedAt;
    // Die mitgelieferte ConPTY (OpenConsole) fragt beim Start Device Attributes ab (`ESC [ c`)
    // und wartet bis zu 3 s auf Antwort. xterm.js antwortet selbst; hier antwortet das Skript.
    if (data.includes("\x1b[c")) term.write("\x1b[?1;2c");
    state.output += data;
  });
  term.onExit(() => {
    state.exited = true;
    openPtys.delete(state);
  });
  openPtys.add(state);
  return state;
}

async function killPty(state) {
  if (state.exited) return;
  state.term.kill();
  const deadline = Date.now() + 5000;
  while (!state.exited && Date.now() < deadline) await sleep(50);
}

async function waitFor(predicate, timeoutMs, intervalMs = 100) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return Date.now() - startedAt;
    await sleep(intervalMs);
  }
  return -1;
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHMc]/g, "");
}

async function capture(extra = []) {
  const result = await tmux(["capture-pane", "-p", "-J", ...extra, "-t", SESSION]);
  return result.stdout;
}

async function main() {
  const ptyVersion = (await import("node-pty/package.json", { with: { type: "json" } })).default.version;
  console.log(
    `node ${process.version}, node-pty ${ptyVersion}, wsl ${WSL_RUN}, useConptyDll ${USE_CONPTY_DLL}`,
  );

  // 0. Argumentübergabe: `--` geht durch die Shell, `--exec` nicht
  const viaShell = await wsl(["-d", DISTRO, "--cd", "~", "--", "echo", "$HOME", "a;b"]);
  const viaExec = await wsl(["-d", DISTRO, "--cd", "~", "--exec", "echo", "$HOME", "a;b"]);
  record(
    "wsl.exe `--` interpretiert Shell-Syntax, `--exec` reicht Argumente wörtlich durch",
    viaShell.stdout.trim() !== "$HOME a;b" && viaExec.stdout.trim() === "$HOME a;b",
    `-- => ${JSON.stringify(viaShell.stdout.trim())}, --exec => ${JSON.stringify(viaExec.stdout.trim())}`,
  );

  await tmux(["kill-session", "-t", SESSION]);

  // 1. Session anlegen und Marker schreiben
  const first = spawnTmux(["new-session", "-A", "-s", SESSION]);
  const promptMs = await waitFor(async () => /[$#] *$/m.test((await capture()).trimEnd()), 15000, 200);
  record("PTY startet tmux-Session", promptMs >= 0, `Prompt nach ${promptMs} ms, erste Daten nach ${first.firstDataAt} ms`);
  // ADR 0003: verwaltete Sessions ohne Statuszeile, sonst meldet tmux eine Zeile weniger
  await tmux(["set-option", "-t", SESSION, "status", "off"]);

  const writeAt = Date.now();
  first.term.write(`echo ${MARKER}\r`);
  const echoMs = await waitFor(() => first.output.includes(MARKER), 5000, 5);
  record("Eingabe-Echo kommt über PTY zurück", echoMs >= 0, `Echo nach ${Date.now() - writeAt} ms`);
  const markerMs = await waitFor(async () => new RegExp(`^${MARKER}$`, "m").test(await capture()), 5000, 100);
  record("Marker-Ausgabe steht im Pane", markerMs >= 0);

  // 2. Resize der PTY -> tmux meldet neue Größe
  first.term.resize(132, 40);
  await sleep(300);
  first.term.write("clear; echo size=$(stty size) cols=$(tput cols)\r");
  const sizeMs = await waitFor(async () => /^size=40 132 cols=132$/m.test(await capture()), 5000, 100);
  record("Resize auf 132x40: stty size/tput cols melden neue Größe", sizeMs >= 0, (await capture()).match(/^size=.*$/m)?.[0] ?? "keine Ausgabe");

  // 3. Farbsequenz kommt über PTY und bleibt in capture-pane -e erhalten
  first.term.write("printf '\\033[31mrot-456\\033[0m \\033[38;5;208morange-789\\033[0m\\n'\r");
  const colorMs = await waitFor(() => first.output.includes("\x1b[31mrot-456"), 5000, 20);
  record("Farbsequenz SGR 31 kommt über PTY an", colorMs >= 0);
  const captureE = await capture(["-e"]);
  record(
    "capture-pane -e enthält Farbsequenzen (31 und 256-Farben 208)",
    captureE.includes("\x1b[31mrot-456") && /\x1b\[38;5;208morange-789/.test(captureE),
  );

  // Marker erneut ausgeben, weil `clear` den sichtbaren Bereich geleert hat
  first.term.write(`echo ${MARKER}\r`);
  await waitFor(async () => new RegExp(`^${MARKER}$`, "m").test(await capture()), 5000, 100);

  // 4. PTY beenden, Session lebt weiter
  await killPty(first);
  record("PTY beendet", first.exited);
  if (idleSeconds > 0) {
    // --keepalive: ein wsl.exe-Prozess ohne PTY hält die Distro am Leben
    const keepalive = KEEPALIVE
      ? spawn("wsl.exe", ["-d", DISTRO, "--cd", "~", "--exec", "sleep", "infinity"], {
          stdio: "ignore",
          windowsHide: true,
        })
      : null;
    console.log(`warte ${idleSeconds} s ohne PTY${keepalive ? " (mit keepalive)" : ""} ...`);
    await sleep(idleSeconds * 1000);
    const running = await wsl(["--list", "--running", "--quiet"]);
    console.log(`laufende Distros: ${JSON.stringify(running.stdout.trim())}`);
    if (keepalive) KEEPALIVE_PROCS.push(keepalive);
  }
  const has = await tmux(["has-session", "-t", SESSION]);
  record("has-session nach PTY-Ende: Session lebt", has.code === 0, `exit ${has.code}`);

  // 5. Neu anhängen, Snapshot prüfen
  const reattachAt = Date.now();
  const second = spawnTmux(["attach-session", "-t", SESSION], 132, 40);
  const redrawMs = await waitFor(() => stripAnsi(second.output).includes(MARKER), 10000, 20);
  record("Reattach: neue PTY zeichnet Marker neu", redrawMs >= 0, `nach ${Date.now() - reattachAt} ms`);
  const snapshot = await capture();
  record("Reattach: capture-pane -p -J zeigt marker-123", new RegExp(`^${MARKER}$`, "m").test(snapshot));
  const snapshotE = await capture(["-e"]);
  record("Reattach: capture-pane -p -e -J behält Farben", snapshotE.includes("\x1b[31mrot-456"));

  await killPty(second);
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  record("Unerwarteter Fehler", false, String(error?.stack ?? error));
} finally {
  for (const state of openPtys) await killPty(state);
  for (const proc of KEEPALIVE_PROCS) proc.kill();
  const killed = await tmux(["kill-session", "-t", SESSION]);
  record("Aufräumen: kill-session", killed.code === 0);
  const gone = await tmux(["has-session", "-t", SESSION]);
  record("Aufräumen: Session existiert nicht mehr", gone.code !== 0);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} Prüfungen bestanden`);
  exitCode = failed === 0 ? 0 : 1;
}
process.exit(exitCode);
