// Phase-0-PoC: Electron-Main hält genau eine PTY für eine WSL-tmux-Session und verteilt deren
// Ausgabe an alle Fenster. Nur das schreibende Fenster darf Eingaben und Resize senden.
//
// Start:      npm start                (zwei Fenster, Session td-poc)
// Selbsttest: npm run self-test        (automatischer Ablauf, Ergebnis als JSON auf stdout)

import { app, BrowserWindow, ipcMain } from "electron";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import pty from "node-pty";

const here = path.dirname(fileURLToPath(import.meta.url));
const SELF_TEST = process.argv.includes("--self-test");
const DISTRO = "Ubuntu";
const SOCKET = "termdock-poc";
const SESSION = SELF_TEST ? "td-poc-selftest" : "td-poc";
const TRUECOLOR = !process.argv.includes("--no-rgb");

/** Zustand der einen Session. */
const session = {
  /** @type {import("node-pty").IPty | null} */
  pty: null,
  /** webContents-ID des schreibenden Fensters */
  writerId: /** @type {number | null} */ (null),
  cols: 100,
  rows: 30,
  generation: 0,
};

// `--exec` statt `--`: Mit `--` reicht wsl.exe die Argumente an die Login-Shell weiter.
function wslArgs(tmuxArgs) {
  return ["-d", DISTRO, "--cd", "~", "--exec", "tmux", "-L", SOCKET, ...tmuxArgs];
}

function tmux(tmuxArgs) {
  return new Promise((resolve) => {
    execFile(
      "wsl.exe",
      wslArgs(tmuxArgs),
      { env: { ...process.env, WSL_UTF8: "1" }, timeout: 15000, windowsHide: true },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function startPty(mode) {
  // `-T RGB`: der Client meldet Truecolor, sonst rechnet tmux 24-Bit-Farben auf 256 Farben herunter.
  // `; set-option status off` läuft im selben Aufruf, also ohne Wettlauf mit dem Session-Start.
  const command =
    mode === "new" ? ["new-session", "-A", "-s", SESSION] : ["attach-session", "-t", SESSION];
  const args = [...(TRUECOLOR ? ["-T", "RGB"] : []), ...command, ";", "set-option", "-t", SESSION, "status", "off"];
  const generation = ++session.generation;
  const term = pty.spawn("wsl.exe", wslArgs(args), {
    name: "xterm-256color",
    cols: session.cols,
    rows: session.rows,
    cwd: app.getPath("home"),
    env: process.env,
    // Mitgelieferte conpty.dll/OpenConsole.exe: vermeidet den fehlschlagenden
    // conpty_console_list_agent beim kill() der System-ConPTY.
    useConptyDll: true,
  });
  term.onData((data) => broadcast("pty:data", data));
  term.onExit(({ exitCode }) => {
    if (generation === session.generation) {
      session.pty = null;
      broadcast("pty:status", { attached: false, exitCode });
    }
  });
  session.pty = term;
  broadcast("pty:status", { attached: true, mode });
  return term;
}

async function stopPty() {
  const term = session.pty;
  if (!term) return;
  session.generation++;
  session.pty = null;
  const exited = new Promise((resolve) => term.onExit(resolve));
  term.kill();
  await Promise.race([exited, sleep(5000)]);
}

/** Snapshot des sichtbaren Bereichs inklusive Farben und Cursorposition. */
async function snapshot() {
  const content = await tmux(["capture-pane", "-p", "-e", "-J", "-t", SESSION]);
  const cursor = await tmux(["display-message", "-p", "-t", SESSION, "#{cursor_x} #{cursor_y}"]);
  const [x, y] = cursor.stdout.trim().split(" ").map(Number);
  const lines = content.stdout.replace(/\n$/, "").split("\n");
  // -J verbindet umbrochene Zeilen; der Renderer bricht sie bei gleicher Breite wieder um.
  return { data: lines.join("\r\n"), cursorX: x || 0, cursorY: y || 0 };
}

async function reattach() {
  await stopPty();
  const has = await tmux(["has-session", "-t", SESSION]);
  if (has.code !== 0) {
    broadcast("pty:status", { attached: false, error: "session_missing" });
    return { ok: false, hasSession: false };
  }
  broadcast("pty:snapshot", await snapshot());
  startPty("attach");
  return { ok: true, hasSession: true };
}

function setWriter(webContentsId) {
  session.writerId = webContentsId;
  broadcast("writer:changed", { writerId: webContentsId, cols: session.cols, rows: session.rows });
}

ipcMain.handle("term:hello", async (event) => ({
  id: event.sender.id,
  writerId: session.writerId,
  cols: session.cols,
  rows: session.rows,
  snapshot: session.pty ? await snapshot() : null,
}));

ipcMain.on("term:input", (event, data) => {
  if (event.sender.id !== session.writerId || typeof data !== "string") return;
  session.pty?.write(data);
});

ipcMain.on("term:resize", (event, size) => {
  if (event.sender.id !== session.writerId) return;
  const cols = Math.max(2, Math.min(500, Math.floor(size?.cols)));
  const rows = Math.max(2, Math.min(300, Math.floor(size?.rows)));
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
  if (cols === session.cols && rows === session.rows) return;
  session.cols = cols;
  session.rows = rows;
  session.pty?.resize(cols, rows);
  broadcast("pty:resized", { cols, rows });
});

ipcMain.on("term:claim-writer", (event) => setWriter(event.sender.id));
ipcMain.handle("term:reattach", () => reattach());
ipcMain.on("term:open-window", () => createWindow("C", 760, 520));

function createWindow(label, width, height, x, y) {
  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    title: `TermDock PoC – Fenster ${label}`,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(here, "renderer", "index.html"), { query: { label } });
  const id = win.webContents.id;
  win.on("closed", () => {
    // Schreiber geschlossen: Schreibrecht an ein verbleibendes Fenster, damit Eingabe und
    // Terminal-Antworten (DA1) nicht verwaist sind
    if (session.writerId !== id) return;
    const next = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    setWriter(next ? next.webContents.id : null);
  });
  return win;
}

// ---------- Selbsttest ----------

async function waitFor(fn, timeoutMs, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return { ms: Date.now() - start, value };
    await sleep(intervalMs);
  }
  return { ms: -1, value: null };
}

async function selfTest(winA, winB) {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail });
  const js = (win, code) => win.webContents.executeJavaScript(code, true);
  const text = (win) => js(win, "window.__poc.text()");
  const type = (win, data) => js(win, `window.__poc.type(${JSON.stringify(data)})`);
  const state = (win) => js(win, "window.__poc.state()");
  const paneText = async () => (await tmux(["capture-pane", "-p", "-J", "-t", SESSION])).stdout;

  await Promise.all([winA, winB].map((w) => waitFor(() => js(w, "Boolean(window.__poc)"), 10000)));
  const prompt = await waitFor(async () => /[$#] *$/.test((await paneText()).trimEnd()), 15000, 200);
  check("tmux-Session startet, Prompt sichtbar", prompt.ms >= 0, `${prompt.ms} ms`);

  // A übernimmt Schreibrecht, B versucht zu schreiben
  await js(winA, "document.getElementById('claim').click()");
  await sleep(500);
  const sizeA = await state(winA);
  await type(winB, "echo blocked-from-B\r");
  await type(winA, "clear; echo from-A-$((40+2)); echo size=$(stty size)\r");
  const outA = await waitFor(async () => (await text(winB)).includes("from-A-42") && (await text(winA)).includes("from-A-42"), 5000);
  check("Eingabe aus A erscheint in A und B", outA.ms >= 0, `${outA.ms} ms`);
  const paneA = await paneText();
  check("Eingabe aus B ohne Schreibrecht wird verworfen", !paneA.includes("blocked-from-B"));
  const sttyA = paneA.match(/^size=(\d+) (\d+)$/m);
  check(
    "stty size meldet Größe von A",
    sttyA && Number(sttyA[1]) === sizeA.rows && Number(sttyA[2]) === sizeA.cols,
    `stty ${sttyA?.[1]}x${sttyA?.[2]} (rows x cols), A ${sizeA.rows}x${sizeA.cols}`,
  );
  const latencies = [];
  for (let i = 0; i < 15; i++) {
    latencies.push(await js(winA, `window.__poc.measureEcho('q${i}z${Date.now() % 1000}')`));
    await sleep(100);
  }
  const sorted = [...latencies].sort((x, y) => x - y);
  check(
    "Echo-Latenz Tastendruck in A → Echo in A (15 Messungen)",
    sorted[0] >= 0,
    `min ${sorted[0]} ms, Median ${sorted[7]} ms, max ${sorted[14]} ms`,
  );

  // Schreiberwechsel zu B
  await js(winB, "document.getElementById('claim').click()");
  await sleep(500);
  const sizeB = await state(winB);
  const viewA = await state(winA);
  check(
    "Nach Wechsel: A stellt Größe des Schreibers B dar",
    viewA.cols === sizeB.cols && viewA.rows === sizeB.rows && !viewA.isWriter && sizeB.isWriter,
    `A zeigt ${viewA.cols}x${viewA.rows}, B fit ${sizeB.cols}x${sizeB.rows}`,
  );
  check("A und B haben unterschiedliche eigene Fenstergrößen", sizeA.cols !== sizeB.cols || sizeA.rows !== sizeB.rows);
  await type(winA, "echo blocked-from-A\r");
  await type(winB, "clear; echo from-B-$((50+5)); echo size=$(stty size) cols=$(tput cols)\r");
  const outB = await waitFor(async () => (await text(winA)).includes("from-B-55") && (await text(winB)).includes("from-B-55"), 5000);
  check("Eingabe aus B erscheint in A und B", outB.ms >= 0, `${outB.ms} ms`);
  const paneB = await paneText();
  check("Eingabe aus A nach Wechsel wird verworfen", !paneB.includes("blocked-from-A"));
  const sttyB = paneB.match(/^size=(\d+) (\d+) cols=(\d+)$/m);
  check(
    "stty size/tput cols melden Größe von B",
    sttyB && Number(sttyB[1]) === sizeB.rows && Number(sttyB[2]) === sizeB.cols && Number(sttyB[3]) === sizeB.cols,
    sttyB?.[0],
  );

  // Farben und TUI
  await type(winB, "printf '\\033[31mrot-456\\033[0m \\033[38;5;208morange-789\\033[0m \\033[38;2;10;200;30mtrue-321\\033[0m\\n'\r");
  const colors = await waitFor(async () => {
    const [a, b] = await Promise.all([winA, winB].map((w) => js(w, "window.__poc.colorsAt('rot-456')")));
    return a && b ? { a, b } : null;
  }, 5000);
  const expected = { "rot-456": "palette:1", "orange-789": "palette:208", "true-321": "rgb:0ac81e" };
  const sameColors = (c) => c && Object.entries(expected).every(([k, v]) => c[k] === v);
  check(
    "Farben (16/256/Truecolor) kommen in A und B an",
    colors.ms >= 0 && sameColors(colors.value.a) && sameColors(colors.value.b),
    JSON.stringify(colors.value?.a),
  );

  // vim: tmux selbst läuft im Alternate Screen von xterm.js, deshalb Pane-Zustand aus tmux lesen
  const paneAlt = async () =>
    (await tmux(["display-message", "-p", "-t", SESSION, "#{alternate_on}"])).stdout.trim() === "1";
  await type(winB, "clear; vim -u NONE -N +'syntax on' /etc/profile\r");
  const vim = await waitFor(async () => (await paneAlt()) && (await text(winA)).includes('"/etc/profile"'), 8000, 200);
  check("vim: startet im Alternate Screen, Datei in A sichtbar", vim.ms >= 0, `${vim.ms} ms`);
  const vimColors = await js(winA, "window.__poc.distinctColors()");
  check("vim: Syntax-Highlighting erzeugt mehrere Farben in A", vimColors.length >= 3, vimColors.join(","));
  await type(winB, "\x1b:q!\r");
  const vimClosed = await waitFor(async () => !(await paneAlt()), 5000, 200);
  check("vim beendet, Alternate Screen verlassen", vimClosed.ms >= 0);

  // Resize von B
  winB.setSize(1000, 700);
  const resized = await waitFor(async () => {
    const b = await state(winB);
    const a = await state(winA);
    return b.cols !== sizeB.cols && a.cols === b.cols && a.rows === b.rows ? { a, b } : null;
  }, 5000);
  await type(winB, "clear; echo size2=$(stty size)\r");
  const stty2 = await waitFor(async () => (await paneText()).match(/^size2=(\d+) (\d+)$/m), 5000);
  check(
    "Fenster-Resize von B: tmux und A folgen",
    resized.ms >= 0 && stty2.value && Number(stty2.value[1]) === resized.value.b.rows && Number(stty2.value[2]) === resized.value.b.cols,
    `B ${resized.value?.b.cols}x${resized.value?.b.rows}, stty ${stty2.value?.[0]}`,
  );
  winA.setSize(500, 350);
  await sleep(700);
  const afterReaderResize = await paneText();
  await type(winB, "clear; echo size3=$(stty size)\r");
  const stty3 = await waitFor(async () => (await paneText()).match(/^size3=(\d+) (\d+)$/m), 5000);
  check(
    "Fenster-Resize vom Leser A ändert tmux-Größe nicht",
    stty3.value && Number(stty3.value[2]) === resized.value?.b.cols,
    `${stty3.value?.[0]} ${afterReaderResize.length > 0 ? "" : "(leer)"}`.trim(),
  );

  // Detach/Reattach mit Snapshot
  await type(winB, "clear; printf '\\033[31mrot-456\\033[0m \\033[38;5;208morange-789\\033[0m \\033[38;2;10;200;30mtrue-321\\033[0m\\n'\r");
  await type(winB, `echo reattach-marker-$((7*111))\r`);
  await waitFor(async () => (await paneText()).includes("reattach-marker-777"), 5000);
  const t0 = Date.now();
  const reattachResult = await js(winB, "window.__poc.reattach()");
  const reattachMs = Date.now() - t0;
  check("Reattach: PTY beendet, Session lebt (has-session)", reattachResult.hasSession, `${reattachMs} ms bis neue PTY`);
  const snapA = await js(winA, "window.__poc.lastSnapshotText()");
  check("Reattach: Snapshot in A enthält Marker", snapA.includes("reattach-marker-777"));
  const live = await waitFor(async () => (await text(winA)).includes("reattach-marker-777"), 5000);
  check("Reattach: A zeigt Marker nach Redraw", live.ms >= 0);
  await type(winB, "echo after-reattach-$((3*3))\r");
  const afterRe = await waitFor(async () => (await text(winA)).includes("after-reattach-9"), 5000);
  check("Reattach: Eingabe aus B geht an neue PTY", afterRe.ms >= 0, `${afterRe.ms} ms`);

  // Neues Fenster bekommt Snapshot
  const winC = createWindow("C", 760, 520, 60, 60);
  await waitFor(() => js(winC, "Boolean(window.__poc)"), 10000);
  const snapC = await waitFor(async () => (await js(winC, "window.__poc.lastSnapshotText()")).includes("after-reattach-9"), 5000);
  const stateC = await state(winC);
  check(
    "Neues Fenster C: Snapshot per capture-pane -e -J, Größe des Schreibers",
    snapC.ms >= 0 && !stateC.isWriter && stateC.cols === resized.value?.b.cols,
    `C ${stateC.cols}x${stateC.rows}`,
  );
  const snapCColors = await js(winC, "window.__poc.colorsAt('rot-456')");
  check("Neues Fenster C: Snapshot behält Farben", sameColors(snapCColors), JSON.stringify(snapCColors));

  return results;
}

app.whenReady().then(async () => {
  if (SELF_TEST) await tmux(["kill-session", "-t", SESSION]);
  const winA = createWindow("A", 900, 600, 20, 20);
  const winB = createWindow("B", 700, 450, 940, 20);
  // Das erste Fenster schreibt; ohne Schreiber würde niemand die DA1-Abfrage der ConPTY beantworten.
  setWriter(winA.webContents.id);
  // Erst starten, wenn der Schreiber zuhört: Sonst geht die DA1-Abfrage der ConPTY verloren
  // und der Start hängt ca. 3 s.
  await new Promise((resolve) => winA.webContents.once("did-finish-load", resolve));
  startPty("new");

  if (!SELF_TEST) return;
  let results;
  try {
    results = await selfTest(winA, winB);
  } catch (error) {
    results = [{ name: "Selbsttest abgebrochen", ok: false, detail: String(error?.stack ?? error) }];
  }
  await stopPty();
  await tmux(["kill-session", "-t", SESSION]);
  const summary = {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    passed: results.filter((r) => r.ok).length,
    total: results.length,
    results,
  };
  const json = JSON.stringify(summary, null, 2);
  process.stdout.write(`${json}\n`);
  const outIndex = process.argv.indexOf("--out");
  if (outIndex > 0) writeFileSync(process.argv[outIndex + 1], json);
  app.exit(summary.passed === summary.total ? 0 : 1);
});

app.on("window-all-closed", async () => {
  await stopPty();
  app.quit();
});
