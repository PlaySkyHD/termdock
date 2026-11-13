# Phase 0: Bericht zum Proof of Concept

Issue #1. Stand: 13.11.2026. Code: `poc/` (eigenes npm-Paket, nicht in den Workspaces, nicht in CI, von ESLint und Prettier ausgenommen).

## Kurzfassung

| Abnahmefrage                                         | Ergebnis                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| (1) node-pty-Build/Prebuild für Electron und Node?   | **Ja, per Prebuild.** Offizielles `node-pty` 1.1.0, N-API-Prebuild `win32-x64`, ohne Rebuild in Node 25 und Electron 45. Bau aus Quelltext scheitert auf dem Host, ist aber nicht nötig. |
| (2) Reattach mit Snapshot korrekt?                   | **Ja.** PTY beenden, tmux-Session lebt, neue PTY mit `attach-session`, Snapshot per `capture-pane -p -e -J` inklusive Farben. Bedingung: WSL darf die Distro nicht beenden (Keepalive nötig). |
| (3) Zwei Fenster, exklusive Eingabe, korrektes Resize? | **Ja (automatisch belegt).** Eine PTY im Main, Ausgabe synchron in beiden Fenstern, Eingaben des Lesers werden verworfen, nur der Schreiber bestimmt die Größe, `stty size` folgt dem Schreiber. |
| (4) TUI-Kompatibilität?                              | **Ja für vim, Farben (16/256/Truecolor) und Größe.** Truecolor nur mit `tmux -T RGB`. `claude`, `codex` und `htop` sind in WSL nicht installiert. |

ADR 0003 ist angepasst: `--exec` statt `--`, `-T RGB`, `status off` im selben Aufruf, Keepalive-Prozess je Distro, node-pty-Variante.

## Versionen

| Komponente       | Version                                     |
| ---------------- | ------------------------------------------- |
| Electron         | 45.3.1 (Node 24.22.2, Chromium 156.0.8078.96) |
| Node (Host)      | 25.2.1                                      |
| node-pty         | 1.1.0 (offizielles Paket, Prebuilds)        |
| @xterm/xterm     | 6.0.0                                       |
| @xterm/addon-fit | 0.11.0                                      |
| WSL              | 3.0.5.0, Kernel 6.18.58.1-1                 |
| Distro / tmux    | Ubuntu, Benutzer `nic`, tmux 3.6            |
| Host             | Windows 11 Pro 10.0.26200, Visual Studio Community 2026 (18.3) |

Alle Versionen sind in `poc/package.json` exakt gepinnt, `poc/package-lock.json` ist eingecheckt.

## Befehle

```sh
cd poc
npm ci
npm run check:reattach                 # Node-Skript ohne Electron (scripts/reattach-check.mjs)
npm run check:reattach:electron-node   # dasselbe Skript mit Electrons Node (ELECTRON_RUN_AS_NODE=1)
npm start                              # zwei Fenster, Session td-poc auf Socket termdock-poc
npm run self-test                      # automatischer GUI-Ablauf, JSON auf stdout, Exit-Code 0/1
```

Optionen von `reattach-check.mjs`: `--idle <s>` (Pause ohne `wsl.exe` vor `has-session`), `--keepalive` (während der Pause `wsl.exe --exec sleep infinity` offen halten), `--dash-dash` (Start mit `--` wie im Issue statt `--exec`), `--no-conpty-dll` (System-ConPTY). Der Selbsttest nimmt `--out <datei>` für die JSON-Ausgabe und `--no-rgb` (ohne `-T RGB`).

Aufräumen nach `npm start`: `wsl.exe -d Ubuntu --exec tmux -L termdock-poc kill-session -t td-poc`.

**Achtung in Agent-Shells:** Ist `ELECTRON_RUN_AS_NODE=1` gesetzt (bei Agents, die selbst in Electron laufen), startet `electron .` als Node und bricht mit „does not provide an export named 'BrowserWindow'“ ab. Vorher `unset ELECTRON_RUN_AS_NODE`.

## Aufbau

- `poc/src/main.mjs`: Electron-Main. Hält **eine** PTY (`wsl.exe -d Ubuntu --cd ~ --exec tmux -L termdock-poc -T RGB new-session -A -s td-poc ; set-option -t td-poc status off`). Verteilt `pty:data` an alle Fenster. Merkt sich den Schreiber (`webContents.id`); `term:input` und `term:resize` von anderen Fenstern werden verworfen. Detach/Reattach: PTY beenden, `has-session`, Snapshot (`capture-pane -p -e -J` plus Cursor aus `display-message '#{cursor_x} #{cursor_y}'`) an alle Fenster, neue PTY mit `attach-session`. Neue Fenster bekommen beim `term:hello` denselben Snapshot.
- `poc/src/preload.cjs`: `contextBridge` mit schmaler API, `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- `poc/src/renderer/`: xterm.js als ES-Modul, CSP ohne Inline-Skripte. Buttons „Schreibrecht übernehmen“, „Detach/Reattach“, „Neues Fenster“. Der Schreiber passt sich per FitAddon an sein Fenster an und sendet die Größe; Leser stellen das Terminal in der Größe des Schreibers dar und zeigen sie in der Statuszeile an.
- `poc/scripts/reattach-check.mjs`: Reattach-Prüfung ohne Electron.

## Ergebnisse im Detail

### (1) node-pty

- `npm install node-pty@1.1.0` lädt kein Binary nach, sondern bringt `prebuilds/win32-x64/{pty,conpty,conpty_console_list}.node` plus `conpty.dll`/`OpenConsole.exe` mit. `scripts/prebuild.js` findet sie, `node-gyp` läuft nicht.
- Die Module nutzen `node-addon-api` (N-API), deshalb lädt **dieselbe Datei** unter Node 25.2.1, im Electron-45-Main und unter Electron als Node (`ELECTRON_RUN_AS_NODE=1`, Node 24.22.2). Belegt durch `check:reattach`, `check:reattach:electron-node` (jeweils 14/14) und den Selbsttest (22/22). `@electron/rebuild` ist nicht nötig.
- Bau aus Quelltext (geprüft in einem Temp-Verzeichnis außerhalb des Repos, mit `node-gyp rebuild` und mit `@electron/rebuild` 4.2.1 für Electron 45.3.1) scheitert auf diesem Host an drei Stellen nacheinander:
  1. npm bündelt node-gyp 11.4.2, das VS 2026 (Version 18) nicht erkennt („unknown version "undefined"“). node-gyp 13.1.0 findet es.
  2. `deps/winpty/.../GetCommitHash.bat` wird nicht gefunden, solange `NoDefaultCurrentDirectoryInExePath=1` gesetzt ist (in Agent-Shells der Fall).
  3. MSBuild bricht mit `MSB8040` ab: node-pty verlangt die MSVC-Bibliotheken mit Spectre-Entschärfung, die im Visual-Studio-Installer nicht installiert sind.
- Alternativen wie `@homebridge/node-pty-prebuilt-multiarch` (0.15.0) waren nicht nötig und wurden nicht weiter geprüft.
- `useConptyDll: true` (mitgelieferte ConPTY) ist die bessere Wahl: Mit der System-ConPTY startet `kill()` den Hilfsprozess `conpty_console_list_agent`, der regelmäßig mit „AttachConsole failed“ auf stderr abstürzt (harmlos, aber laut). Mit `useConptyDll` tritt das nicht auf.

### (2) Reattach

Ausgabe von `node scripts/reattach-check.mjs` (Node 25.2.1):

```text
node v25.2.1, node-pty 1.1.0, wsl --exec, useConptyDll true
PASS  wsl.exe `--` interpretiert Shell-Syntax, `--exec` reicht Argumente wörtlich durch  (-- => "/home/nic a", --exec => "$HOME a;b")
PASS  PTY startet tmux-Session  (Prompt nach 428 ms, erste Daten nach 8 ms)
PASS  Eingabe-Echo kommt über PTY zurück  (Echo nach 7 ms)
PASS  Marker-Ausgabe steht im Pane
PASS  Resize auf 132x40: stty size/tput cols melden neue Größe  (size=40 132 cols=132)
PASS  Farbsequenz SGR 31 kommt über PTY an
PASS  capture-pane -e enthält Farbsequenzen (31 und 256-Farben 208)
PASS  PTY beendet
PASS  has-session nach PTY-Ende: Session lebt  (exit 0)
PASS  Reattach: neue PTY zeichnet Marker neu  (nach 122 ms)
PASS  Reattach: capture-pane -p -J zeigt marker-123
PASS  Reattach: capture-pane -p -e -J behält Farben
PASS  Aufräumen: kill-session
PASS  Aufräumen: Session existiert nicht mehr

14/14 Prüfungen bestanden
```

Unter Electrons Node (`npm run check:reattach:electron-node`, Node 24.22.2) ebenfalls 14/14.

**WSL-Idle-Abschaltung (wichtigster Befund für #4):** Läuft kein `wsl.exe`-Prozess mehr, beendet WSL die Distro und damit den tmux-Server.

| Lauf                          | Pause ohne PTY | `wsl --list --running` | `has-session` |
| ----------------------------- | -------------- | ---------------------- | ------------- |
| `--idle 8`                    | 8 s            | `Ubuntu`               | lebt          |
| `--idle 20`                   | 20 s           | leer                   | weg           |
| `--idle 90`                   | 90 s           | leer                   | weg           |
| `--idle 90 --keepalive`       | 90 s           | `Ubuntu`               | lebt          |

Es gibt keine `.wslconfig` auf dem Host, es gelten also die WSL-Standardwerte. Ein `wsl.exe -d Ubuntu --exec sleep infinity` ohne PTY reicht als Keepalive.

Reattach-Zeiten (Selbsttest): PTY beenden bis neue PTY läuft ca. 450 ms, darin drei `wsl.exe`-Aufrufe (`has-session`, `capture-pane`, `display-message`). Ein einzelner `wsl.exe --exec tmux ...`-Aufruf kostet bei laufender Distro ca. 120 ms, bei gestoppter Distro (Kaltstart) ca. 3,7 s. Redraw der neuen PTY nach ca. 120 ms.

### (3) Zwei Fenster, exklusive Eingabe, Resize

Ausgabe von `npm run self-test` (gekürzt auf Name und Detail):

```text
45.3.1 24.22.2 156.0.8078.96 22/22
PASS tmux-Session startet, Prompt sichtbar 168 ms
PASS Eingabe aus A erscheint in A und B 110 ms
PASS Eingabe aus B ohne Schreibrecht wird verworfen
PASS stty size meldet Größe von A stty 33x113 (rows x cols), A 33x113
PASS Echo-Latenz Tastendruck in A → Echo in A (15 Messungen) min 1 ms, Median 1 ms, max 3 ms
PASS Nach Wechsel: A stellt Größe des Schreibers B dar A zeigt 87x23, B fit 87x23
PASS A und B haben unterschiedliche eigene Fenstergrößen
PASS Eingabe aus B erscheint in A und B 109 ms
PASS Eingabe aus A nach Wechsel wird verworfen
PASS stty size/tput cols melden Größe von B size=23 87 cols=87
PASS Farben (16/256/Truecolor) kommen in A und B an {"rot-456":"palette:1","orange-789":"palette:208","true-321":"rgb:0ac81e"}
PASS vim: startet im Alternate Screen, Datei in A sichtbar 123 ms
PASS vim: Syntax-Highlighting erzeugt mehrere Farben in A palette:4,palette:130,palette:5,palette:1,default,palette:6
PASS vim beendet, Alternate Screen verlassen
PASS Fenster-Resize von B: tmux und A folgen B 126x40, stty size2=40 126
PASS Fenster-Resize vom Leser A ändert tmux-Größe nicht size3=40 126
PASS Reattach: PTY beendet, Session lebt (has-session) 448 ms bis neue PTY
PASS Reattach: Snapshot in A enthält Marker
PASS Reattach: A zeigt Marker nach Redraw
PASS Reattach: Eingabe aus B geht an neue PTY 110 ms
PASS Neues Fenster C: Snapshot per capture-pane -e -J, Größe des Schreibers C 126x40
PASS Neues Fenster C: Snapshot behält Farben {"rot-456":"palette:1","orange-789":"palette:208","true-321":"rgb:0ac81e"}
```

Ablauf: Fenster A (900×600) und B (700×450) öffnen. A übernimmt per Button-Klick das Schreibrecht, B tippt (wird verworfen), A tippt. B übernimmt, A tippt (verworfen), B tippt. Eingaben laufen über `term.input()` von xterm.js, also über denselben Weg wie Tastatureingaben (`onData` → preload → Main). Danach Farben, vim, `BrowserWindow.setSize` für B (Schreiber) und A (Leser), Detach/Reattach per Button in B, Fenster C öffnen. Ausgelesen wird der xterm-Puffer per `webContents.executeJavaScript`, die tmux-Sicht per `capture-pane`.

Latenz: Die Echo-Latenz (Tastendruck im Renderer bis zum Echo im Renderer, ohne Zeichnen) liegt bei 1–3 ms. Die ca. 110 ms bei „erscheint in A und B“ sind das Abfrageintervall des Tests, nicht die Latenz.

### (4) TUI

- `stty size` und `tput cols` melden nach jedem Resize die Größe des Schreibers, sowohl per `pty.resize` (Node-Skript) als auch per Fensterverkleinerung/-vergrößerung (Selbsttest). Resize des Lesers ändert nichts.
- Farben: SGR 16 Farben und 256 Farben kommen immer an. **Truecolor nur mit `tmux -T RGB`**: Ohne das Flag (erster Lauf, entspricht `--no-rgb`) kam `38;2;10;200;30` als Palette-Farbe 40 an.
- vim (`vim -u NONE -N +'syntax on' /etc/profile`): startet im Alternate Screen, Inhalt und Syntax-Farben in A sichtbar, `:q!` verlässt den Alternate Screen. Weil tmux selbst den Alternate Screen von xterm.js belegt, ist `term.buffer.active.type` immer `alternate`; der Pane-Zustand kommt aus `#{alternate_on}`.
- `command -v claude`, `codex`, `htop` in WSL (`bash -ic`): nicht installiert. Nur vim ist vorhanden.

## Was der Nutzer manuell prüfen sollte

Automatisch belegt sind Datenfluss, Rechte, Größenmeldung, Farben im Puffer und Reattach. Nicht automatisch prüfbar ist die Darstellung:

1. `npm start`, in Fenster A tippen, in B tippen (nichts passiert), in B „Schreibrecht übernehmen“, tippen. Grüne Leiste = Schreiber.
2. Fenster des Schreibers mit der Maus ziehen: Leser übernimmt die Größe (größer → Scrollbalken, kleiner → Rand). Prüfen, ob das Beschneiden/Skalieren für Phase 2 akzeptabel aussieht.
3. TUI-Darstellung: `vim`, `less /etc/profile`, `top`; falls installiert `htop`, `claude`, `codex`. Auf Rahmen, Unicode, Cursor, Maus (tmux-Maus ist aus) und Farben achten. Zwischendurch Resize per Maus.
4. Detach/Reattach-Button während vim läuft: Snapshot sollte vim korrekt zeigen, danach weiter bedienbar.
5. Fenster schließen und `npm start` erneut: Session `td-poc` mit altem Inhalt (innerhalb von ca. 8 s, sonst ist die Distro beendet; der PoC hat keinen Keepalive).
6. Clipboard (Kopieren/Einfügen) ist im PoC nicht umgesetzt und offen.

## Fallstricke

- **`wsl.exe --` geht durch die Login-Shell.** `wsl.exe -d Ubuntu -- echo $HOME 'a;b'` liefert `/home/nic a`. Mit `--exec` kommen die Argumente wörtlich an. Für Argument-Arrays (Sicherheitsregel) immer `--exec`. Der PoC weicht deshalb vom Startbefehl im Issue ab; `--dash-dash` zeigt das alte Verhalten.
- **WSL-Idle-Abschaltung** beendet tmux (siehe oben). Keepalive je Distro nötig.
- **DA1-Abfrage der ConPTY.** `OpenConsole.exe` sendet beim Start `ESC [ c` und wartet bis zu 3 s auf eine Antwort, bevor es Ausgabe durchlässt. xterm.js antwortet automatisch, aber nur, wenn ein Renderer schon lauscht und schreiben darf. Im ersten Selbsttestlauf startete die PTY vor dem Laden des Renderers: 3 s bis zum Prompt statt 130 ms. Fix: PTY erst starten, wenn der Schreiber geladen ist. Node-Skripte ohne xterm.js müssen selbst `ESC [ ? 1 ; 2 c` antworten.
- **Automatische Terminal-Antworten nur vom Schreiber.** Jede xterm.js-Instanz antwortet auf DA1/DSR. Würden alle Views antworten, kämen die Antworten mehrfach in der Shell an. Main verwirft `term:input` von Lesern, das deckt auch diese Antworten ab.
- **`status off` im selben tmux-Aufruf.** Ein separates `set-option` 1,5 s nach dem Start verlor gegen den Session-Start (stty meldete 32 statt 33 Zeilen). `new-session ... ; set-option -t <s> status off` als eigene Argumente funktioniert und gilt auch nach Reattach.
- **Truecolor nur mit `-T RGB`** am tmux-Client.
- **`capture-pane` liefert `\n`**: für xterm.js in `\r\n` umwandeln, Cursor separat setzen.
- **System-ConPTY und `kill()`**: stderr-Rauschen „AttachConsole failed“ (siehe oben), mit `useConptyDll: true` behoben.
- **Agent-Umgebung**: `ELECTRON_RUN_AS_NODE=1` und `NoDefaultCurrentDirectoryInExePath=1` sind gesetzt und brechen Electron-Start bzw. node-gyp.

## Empfehlungen

### Für #4 (WSL-Backend)

- Startbefehl als Argument-Array: `wsl.exe -d <distro> --cd <dir> --exec tmux -L termdock -T RGB new-session -A -s td-<id> [befehl...] ; set-option -t td-<id> status off`. Reattach analog mit `attach-session -t td-<id>`. Nie `--`.
- `exists` per `has-session` mit `execFile` und `env: { WSL_UTF8: "1" }`, Timeout setzen. Jeder Aufruf kostet ca. 120 ms (`wsl.exe`-Start), ein Kaltstart der Distro ca. 3,7 s; Snapshot und Cursor eventuell in einem tmux-Aufruf bündeln (`capture-pane ... ; display-message -p ...`).
- **Keepalive** im Backend: pro Distro mit mindestens einer laufenden Session ein `wsl.exe --exec sleep infinity` (per `spawn`, ohne PTY), beim Ende der letzten Session beenden. Integrationstest: PTY beenden, > 20 s warten, `has-session` (wie `reattach-check.mjs --idle 30 --keepalive`).
- `PtyHandle` auf node-pty 1.1.0 mit `useConptyDll: true`, `name: "xterm-256color"`. Prebuilds verwenden, keine Rebuild-Schritte in CI.
- Snapshot: `capture-pane -p -e -J -t td-<id>` (plus `-S -<n>` für Scrollback), Zeilenenden `\r\n`, Cursor aus `#{cursor_x} #{cursor_y}`. Bei Alternate Screen (`#{alternate_on}`) reicht der sichtbare Bereich.
- DA1/DSR: Solange keine schreibende View verbunden ist, sollte der Core einfache Abfragen selbst beantworten (mindestens DA1 beim PTY-Start), sonst hängt der Start bis zu 3 s.
- Tests: Socket `-L termdock-test`, `kill-session` in `afterEach`, PTY-Exit abwarten (bis 5 s).

### Für Desktop (Phase 2)

- Architektur aus dem PoC übernehmen: preload mit schmaler API, `contextIsolation`, `sandbox`, kein `nodeIntegration`. Eingabe und Resize nur vom Schreiber; Main/Core prüft das, nicht nur der Renderer.
- Lesende Views brauchen eine Darstellungsentscheidung für abweichende Größen (Beschneiden mit Scrollbalken wie im PoC oder Skalieren).
- Schreiberwechsel löst sofort ein Resize auf die Größe des neuen Schreibers aus; TUIs zeichnen dann neu. Das ist gewollt, sollte aber sichtbar sein (Statusleiste).
- xterm.js 6 als ES-Modul aus `node_modules` funktioniert ohne Bundler; für die App trotzdem bündeln.
- Electron 45 lädt node-pty im Main; laut ADR 0001 läuft die PTY aber im Core-Prozess (`ELECTRON_RUN_AS_NODE=1`), was `check:reattach:electron-node` ebenfalls belegt.
