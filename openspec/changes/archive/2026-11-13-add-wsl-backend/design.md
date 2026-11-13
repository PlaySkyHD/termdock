# Design

## Context

ADR 0003 legt das WSL-Backend fest, Phase 0 hat die Aufrufe belegt (`docs/poc/phase-0-bericht.md`). Die Schnittstelle `Backend`/`PtyHandle` in `packages/core/src/backend/types.ts` und die Registry (`session/registry.ts`) sind vorgegeben und bleiben unverändert; parallel arbeiten andere Agents an Registry, Storage und IPC.

## Goals / Non-Goals

**Goals:**

- `WslBackend` nach ADR 0003, nur über Argument-Arrays, mit testbaren Nahtstellen (Prozessaufruf, PTY-Erzeugung, Keepalive-Erzeugung injizierbar).
- Unit-Tests ohne WSL für Argumentbau, Pfade, Distro-Liste, Keepalive und PTY-Verhalten; Integrationstests gegen echtes Ubuntu hinter `TERMDOCK_WSL_TESTS=1`.

**Non-Goals:**

- Automatisches Reattach bei verlorenem Client, Reconcile beim Core-Start, Scrollback im Snapshot, Windows-Backend.

## Decisions

### Dependency `node-pty` 1.1.0

Einzige gepflegte ConPTY-Anbindung für Node; Phase 0 hat belegt, dass die mitgelieferten N-API-Prebuilds (`win32-x64`) unter Node 25 und Electron 45 laden, ohne Rebuild. Exakt gepinnt, weil das Verhalten der mitgelieferten ConPTY (DA1-Abfrage) versionsabhängig ist. `useConptyDll: true`, weil die System-ConPTY beim `kill()` „AttachConsole failed“ ausgibt. Das Modul wird erst beim ersten Start einer PTY geladen, damit Unit-Tests es nicht brauchen.

### Aufrufe

- Jeder Aufruf: `wsl.exe -d <distro> --cd <cwd> --exec tmux -L <socket> ...`. `--exec` statt `--`, weil `--` die Login-Shell einschaltet. Aufrufe ohne PTY nutzen `--cd ~` und `env WSL_UTF8=1`, jeweils mit Timeout (Standard 15 s wegen Kaltstart der Distro, ca. 3,7 s).
- Start: `-T RGB new-session -A -s td-<id> [-e K=V …] [befehl…] ; set-option -t =td-<id>: status off ; set-option -w -t =td-<id>: remain-on-exit on ; set-hook -t =td-<id>: pane-died "detach-client -s =td-<id>"`. Reattach: `-T RGB attach-session -t =td-<id>`.
- Ziele mit `=` (exakter Name), sonst trifft `td-1` auch `td-10`. Probe auf tmux 3.6: `set-option`/`set-hook` erwarten ein Pane-Ziel, deshalb `=td-<id>:`; `has-session`, `kill-session`, `attach-session` und `detach-client -s` nehmen `=td-<id>`. `display-message -t` auf eine fehlende Session meldet keinen Fehler, deshalb steht vor jeder Abfrage `has-session -t =td-<id> ;`.
- Session-IDs müssen `^[A-Za-z0-9_-]+$` erfüllen (UUIDs tun das); damit kann der Name weder tmux-Zielsyntax (`:`, `.`) noch Befehlsparser-Zeichen enthalten. Umgebungsvariablen aus `LaunchSpec.env` gehen als `-e NAME=wert` an `new-session`, Namen müssen `^[A-Za-z_][A-Za-z0-9_]*$` erfüllen.
- Ein `command` mit genau einem Element würde tmux an `sh -c` geben. Das Backend stellt dann `env --` voran, damit es wörtlich ausgeführt wird.
- Snapshot in einem Aufruf: `has-session ; capture-pane -p -e -J -t =td-<id>: ; display-message -p -t =td-<id>: "#{cursor_x} #{cursor_y}"`. Die letzte Zeile ist der Cursor, die übrigen Zeilen werden mit `\r\n` verbunden (ohne abschließenden Umbruch). Nur sichtbarer Bereich, weil die Cursorposition sich darauf bezieht.
- `exists`: `has-session ; display-message -p "#{pane_dead}"`. Exit 1 mit `can't find session`, `no server running` oder `error connecting to` heißt „gibt es nicht“; jeder andere Fehler (Distro fehlt, Timeout) wird geworfen, damit die Registry keine fehlende Session mit einem WSL-Ausfall verwechselt. Eine Session mit totem Pane (siehe Exit-Code) zählt als nicht vorhanden; `start` entfernt einen solchen Rest vor `new-session -A`.
- `kill`: `kill-session -t =td-<id>`, danach `has-session` alle 100 ms bis „weg“, Frist 5 s, sonst Fehler.
- Distro: `LaunchSpec.distro` → Option `distro` → Standard-Distro aus `wsl.exe -l -v` (Zeile mit `*`, Ergebnis gecacht). `-l -v` statt `-l -q`, weil nur dort die Standard-Distro markiert ist; die Kopfzeile wird übersprungen (lokalisiert).
- `available`: Distro ermitteln und `tmux -V` ausführen; jeder Fehler ergibt `false`.

### Exit-Code über `remain-on-exit`

Ohne Vorkehrung endet mit dem Programm auch die tmux-Session, und der Exit-Code ist weg. Gewählt: `remain-on-exit on` hält das tote Pane, der Hook `pane-died` trennt den Client (`detach-client`), die PTY endet. Danach fragt das Backend `#{pane_dead} #{pane_dead_status} #{pane_dead_signal}` ab: totes Pane → Exit-Code (Signal → `128 + n`), `kill-session`, Ende mit `exitCode`. Lebendes Pane → nur der Client ging verloren, Ende ohne `exitCode`, Session bleibt. Session fehlt (z. B. `kill`) oder Abfrage scheitert → Ende ohne `exitCode`.

Verworfen: ein Wrapper-Skript in der Session, das den Code in eine Datei schreibt (ändert den Prozessbaum, braucht Dateien in der Distro); Ende ohne Code (die Registry würde jedes normale Programmende als `Interrupted` führen). Einschränkung: Öffnet der Nutzer weitere tmux-Fenster in der Session, trennt das Ende eines beliebigen Panes den Client; V1-Sessions haben ein Pane.

### PTY und DA1

`WslPty` kapselt die node-pty-Instanz. Die mitgelieferte ConPTY sendet beim Start `ESC [ 1 t`, dann `ESC [ c` (gemessen: nach ca. 7 ms, vor jeder anderen Ausgabe) und hält danach alle Ausgabe bis zu 3 s zurück. `WslPty` beantwortet die erste Abfrage mit `ESC [ ? 1 ; 2 c` und entfernt sie aus der Ausgabe; spätere Abfragen gehen an die schreibende View. Abweichend von der ersten Fassung („solange keine Eingabe von außen kam“) verhindert nur eine von außen geschriebene DA1-Antwort (`ESC [ ? … c`) die eigene Antwort: Beim Wiederanbinden schrieb der Integrationstest sofort eine Eingabe, die Antwort entfiel, und das Echo kam erst nach über 3 s. Weil die Abfrage aus der Ausgabe entfernt wird, sieht keine View sie, eine doppelte Antwort ist ausgeschlossen. Belegt: Ohne Antwort schlägt der Integrationstest „Echo < 3 s“ fehl (3359 ms), mit Antwort besteht er. `dispose()` entfernt alle Listener und beendet den Client (`kill()`); ein danach eintreffendes PTY-Ende wird nicht gemeldet. Ausgabe kommt als UTF-8-String von node-pty und wird als `Uint8Array` weitergegeben.

### Zusammenspiel mit der Registry

`releasePty` der Registry löst die Abos vor `dispose()`; ein vom Core ausgelöstes Schließen erzeugt also kein `Interrupted`, zusätzlich meldet `WslPty` nach `dispose()` nichts mehr. Geht der Client unerwartet verloren, während die Session lebt, meldet die PTY ein Ende ohne Exit-Code; die Registry setzt `Interrupted`, und `restart` hängt über `exists` → `attach` wieder an (kein zweiter Prozess). Das ist die sicherste Variante ohne Änderung an `types.ts`/`registry.ts`. Folgeaufgabe: ein eigenes Signal „Client verloren, Session lebt“ (z. B. `onExit({ detached: true })`), bei dem die Registry automatisch per `attach` wieder anbindet statt `Interrupted` zu setzen.

### Keepalive je Distro

Eigene Klasse `DistroKeepalive` mit injizierbarem Spawner: `retain(distro, session)`, `release(distro, session)`, `dispose()`. Erste Session einer Distro startet `wsl.exe -d <distro> --cd ~ --exec sleep infinity` (`spawn`, `stdio: ignore`, ohne PTY), die letzte beendet ihn. Endet der Prozess unerwartet, startet er nach 1 s neu, solange Sessions bekannt sind. `retain` bei `start`, `attach` und `exists` = true; `release` bei `kill`, bei Programm-Ende mit Exit-Code, wenn die Session nach PTY-Ende fehlt, und bei `exists` = false. `WslBackend.dispose()` beendet alle Keepalives, nicht die Sessions.

### Pfade

`wslPath` rechnet `P:\x` bzw. `P:/x` in `/mnt/p/x` um (eine Stelle laut TypeScript-Regeln). Das Backend selbst rechnet nicht um, `LaunchSpec.cwd` ist bereits ein Linux-Pfad.

## Risks / Trade-offs

- Jeder Aufruf ohne PTY kostet ca. 120 ms (`wsl.exe`); `start` macht einen zusätzlichen Aufruf (Rest mit totem Pane entfernen). Akzeptiert für korrektes `new-session -A`.
- Läuft der Core ohne `dispose()` ab, bleiben Keepalive-Prozesse bestehen und halten die Distro wach, bis sie beendet werden. Der Core-Abbau (ADR 0001) muss `dispose()` aufrufen.
- Das Prüfen von tmux-Fehlermeldungen hängt am englischen Text von tmux 3.x.
- ADR 0003 nennt den Startbefehl ohne `remain-on-exit`, Hook und `=`-Ziele und sagt zu DA1 nur „Core antwortet“. Die Präzisierungen gehören ins ADR; dieser Branch ändert laut Auftrag nur `packages/core/src/backend/wsl/`, das ADR folgt in einem eigenen PR.
