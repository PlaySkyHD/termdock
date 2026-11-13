// Renderer: reiner Darsteller. Ausgabe kommt aus Main, Eingabe und Resize nur als Schreiber.
import { Terminal } from "../../node_modules/@xterm/xterm/lib/xterm.mjs";
import { FitAddon } from "../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs";

const api = window.termdock;
const label = new URLSearchParams(location.search).get("label") ?? "?";
const bar = document.getElementById("bar");
const statusEl = document.getElementById("status");
document.getElementById("label").textContent = `Fenster ${label}`;

const term = new Terminal({
  fontFamily: "Cascadia Mono, Consolas, monospace",
  fontSize: 13,
  scrollback: 2000,
  allowProposedApi: true,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("terminal"));

let myId = -1;
let writerId = null;
let size = { cols: term.cols, rows: term.rows };
let lastSnapshot = "";
let attached = true;
const rawListeners = new Set();

const isWriter = () => myId === writerId;

function render() {
  bar.classList.toggle("writer", isWriter());
  const role = isWriter() ? "schreibt" : `liest, Größe des Schreibers ${size.cols}x${size.rows}`;
  statusEl.textContent = `${role}${attached ? "" : " · getrennt"}`;
}

function fitAsWriter() {
  if (!isWriter()) return;
  fit.fit();
  size = { cols: term.cols, rows: term.rows };
  api.resize(term.cols, term.rows);
  render();
}

function showSize(cols, rows) {
  size = { cols, rows };
  if (!isWriter() && (term.cols !== cols || term.rows !== rows)) term.resize(cols, rows);
  render();
}

function applySnapshot(snap) {
  lastSnapshot = snap.data;
  term.reset();
  term.write(snap.data);
  term.write(`\x1b[${snap.cursorY + 1};${snap.cursorX + 1}H`);
}

term.onData((data) => {
  // Leser senden nichts; auch automatische Antworten von xterm.js (z. B. DA1) nur vom Schreiber.
  if (isWriter()) api.input(data);
});

// Bis der Snapshot aus `hello` angewendet ist, Live-Daten puffern; sonst würde der Snapshot
// (term.reset) bereits geschriebene neuere Ausgabe überdecken.
let ready = false;
const pending = [];
function writeLive(data) {
  term.write(data);
  for (const listener of rawListeners) listener(data);
}
api.onData((data) => {
  if (ready) writeLive(data);
  else pending.push(data);
});
api.onSnapshot(applySnapshot);
api.onResized(({ cols, rows }) => showSize(cols, rows));
api.onWriterChanged((payload) => {
  writerId = payload.writerId;
  if (isWriter()) fitAsWriter();
  else showSize(payload.cols, payload.rows);
});
api.onStatus((status) => {
  attached = status.attached;
  render();
});

new ResizeObserver(() => fitAsWriter()).observe(document.getElementById("terminal"));

document.getElementById("claim").addEventListener("click", () => api.claimWriter());
document.getElementById("reattach").addEventListener("click", () => api.reattach());
document.getElementById("open").addEventListener("click", () => api.openWindow());

const hello = await api.hello();
myId = hello.id;
writerId = hello.writerId;
if (hello.snapshot) applySnapshot(hello.snapshot);
ready = true;
for (const data of pending.splice(0)) writeLive(data);
if (isWriter()) fitAsWriter();
else showSize(hello.cols, hello.rows);
term.focus();

function bufferText() {
  const buffer = term.buffer.active;
  const lines = [];
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
  return lines.join("\n");
}

function colorOf(cell) {
  if (cell.isFgRGB()) return `rgb:${cell.getFgColor().toString(16).padStart(6, "0")}`;
  if (cell.isFgPalette()) return `palette:${cell.getFgColor()}`;
  return "default";
}

// Testschnittstelle für `--self-test` (executeJavaScript aus Main)
window.__poc = {
  text: bufferText,
  type: (data) => term.input(data, true),
  reattach: () => api.reattach(),
  lastSnapshotText: () => lastSnapshot,
  state: () => {
    const own = fit.proposeDimensions();
    return {
      label,
      isWriter: isWriter(),
      cols: term.cols,
      rows: term.rows,
      ownCols: own?.cols ?? null,
      ownRows: own?.rows ?? null,
      altScreen: term.buffer.active.type === "alternate",
    };
  },
  distinctColors: () => {
    const buffer = term.buffer.active;
    const seen = new Set();
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      for (let x = 0; line && x < line.length; x++) {
        const cell = line.getCell(x);
        if (cell && cell.getChars().trim()) seen.add(colorOf(cell));
      }
    }
    return [...seen];
  },
  colorsAt: (word) => {
    const buffer = term.buffer.active;
    for (let y = buffer.length - 1; y >= 0; y--) {
      const line = buffer.getLine(y);
      const content = line?.translateToString(true) ?? "";
      if (!content.includes(word)) continue;
      const result = {};
      for (const name of ["rot-456", "orange-789", "true-321"]) {
        const x = content.indexOf(name);
        if (x >= 0) result[name] = colorOf(line.getCell(x));
      }
      return result;
    }
    return null;
  },
  measureEcho: (tag) =>
    new Promise((resolve) => {
      const start = performance.now();
      let seen = "";
      const timer = setTimeout(() => {
        rawListeners.delete(listener);
        resolve(-1);
      }, 3000);
      const listener = (data) => {
        seen += data;
        if (seen.includes(tag)) {
          clearTimeout(timer);
          rawListeners.delete(listener);
          resolve(Math.round(performance.now() - start));
        }
      };
      rawListeners.add(listener);
      term.input(`${tag}`, true);
    }).then((ms) => {
      term.input("\x15", true); // Zeile löschen (Ctrl+U)
      return ms;
    }),
};
