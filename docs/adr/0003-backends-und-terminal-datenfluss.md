# ADR 0003: Backends und Datenfluss zum Terminal

Status: angenommen (13.11.2026), durch Phase 0 bestätigt und präzisiert (`docs/poc/phase-0-bericht.md`)

## Kontext

Dieselbe Session soll in mehreren Fenstern sichtbar sein, aber nur eine View schreibt und bestimmt die Größe (Kapitel 7). WSL-Sessions sollen über tmux langlebig sein (Kapitel 4).

## Entscheidung

- **Eine PTY pro Session im Core, nicht pro View.** Der Core hält für jede laufende Session genau eine PTY (node-pty/ConPTY). Er verteilt deren Ausgabe als `session.output`-Events an alle Views der Session. Views sind reine Darsteller (xterm.js).
- **WSL-Backend:** Die PTY führt `wsl.exe -d <distro> --cd <linux-verzeichnis> --exec tmux -L termdock -T RGB new-session -A -s td-<sessionId> [befehl] ; set-option -t td-<sessionId> status off` aus (Argument-Array, `;` als eigenes Argument). `--exec` statt `--`, weil wsl.exe die Argumente nach `--` an die Login-Shell der Distro weiterreicht (`$HOME`, `;` usw. würden interpretiert, Phase 0). `-T RGB`, weil tmux sonst 24-Bit-Farben auf 256 Farben herunterrechnet. Eigener tmux-Socket `termdock`, damit Nutzer-tmux unberührt bleibt. tmux-Option `status off` im selben Aufruf, sonst meldet die Session eine Zeile weniger als die PTY. Wiederanbinden = neue PTY mit `tmux -L termdock -T RGB attach-session -t td-<sessionId>`. Existenzprüfung über `tmux -L termdock has-session -t td-<sessionId>` (ohne PTY, per `execFile`).
- **WSL am Leben halten:** WSL beendet eine Distro samt tmux-Server, wenn kein `wsl.exe`-Prozess mehr läuft (Phase 0: nach 8 s ohne `wsl.exe` lebte die Session noch, nach 20 s und 90 s war sie weg). Der Core hält deshalb je Distro mit laufenden Sessions einen Keepalive-Prozess `wsl.exe -d <distro> --exec sleep infinity` (ohne PTY) und beendet ihn, wenn die letzte Session der Distro endet.
- **node-pty:** offizielles `node-pty` mit den mitgelieferten N-API-Prebuilds (`win32-x64`), dieselbe Binärdatei für Node und Electron, kein Rebuild. `useConptyDll: true` (mitgelieferte ConPTY). Die ConPTY fragt beim Start Device Attributes (DA1) ab und wartet bis zu 3 s auf Antwort; die WSL-PTY beantwortet diese erste Abfrage deshalb selbst (siehe Präzisierungen).
- **Windows-Backend:** Die PTY führt die Shell direkt aus (`pwsh.exe`, `powershell.exe`, `cmd.exe`). Persistenz nur so lange wie der Core läuft (ADR 0001).
- **Snapshot für neue Views:** Beim `session.attach` liefert der Core einen Snapshot: bei WSL `tmux capture-pane -p -e -J -S -<n>` des sichtbaren Bereichs plus Cursorposition, bei Windows den Inhalt eines begrenzten Rohdaten-Puffers im Core (256 KiB je Session). Danach folgen Live-Events.
- **Größe:** Nur die schreibende View sendet `session.resize`. Der Core ändert die PTY-Größe (tmux folgt dem einzigen Client). Lesende Views bekommen die maßgebliche Größe mit `session.resized` und stellen das Terminal in dieser Größe dar, beschnitten, wenn ihre Fläche kleiner ist (ADR 0006).
- **Backend-Schnittstelle** (`packages/core/src/backend/types.ts`): `start`, `attach`, `exists`, `kill`, `snapshot`, optional `resolveLaunch`, plus eine `PtyHandle` mit `write`, `resize`, `onData`, `onExit`, `dispose`. Tests nutzen `FakeBackend`.

### Präzisierungen aus der Umsetzung (#4, #13)

- **Exakte tmux-Ziele:** Alle Aufrufe adressieren die Session als `=td-<id>` (Pane-Ziele `=td-<id>:`), damit `td-1` nie `td-10` per Präfix trifft. Session-IDs bestehen nur aus Buchstaben, Ziffern, `-` und `_`.
- **Exit-Code über `remain-on-exit`:** Der Start setzt im selben Aufruf `set-option -w -t =td-<id>: remain-on-exit on` und `set-hook -t =td-<id>: pane-died "detach-client -s =td-<id>"`. Endet das Programm, bleibt das Pane tot stehen, der Client wird getrennt, und das Backend liest `#{pane_dead_status}` (bei Signal `128 + Signal`), meldet den Exit-Code und entfernt die Session mit `kill-session`. Ein lebendes Pane nach dem Client-Ende heißt: nur der Client ging verloren (Ende ohne Exit-Code).
- **DA1 in der PTY:** Solange von außen keine DA1-Antwort (`ESC [ ? … c`) geschrieben wurde, beantwortet die WSL-PTY die erste Abfrage `ESC [ c` selbst mit `ESC [ ? 1 ; 2 c` und entfernt sie aus der Ausgabe. So warten Start und Wiederanbinden nicht auf eine View, und keine View antwortet doppelt.
- **Maskierung von `;`:** tmux liest ein Argument, das auf `;` endet, als Befehlstrenner. Das Backend setzt vor ein solches abschließendes `;` genau einen Backslash (tmux entfernt ihn wieder), für `command`-Argumente und `-e`-Umgebungswerte. Ein einzelnes `command`-Argument läuft über `env --`, weil tmux es sonst an `sh -c` gibt.
- **`--cd ~` außer beim Start:** `attach-session`, `has-session`, `kill-session`, `capture-pane` und `display-message` laufen mit `--cd ~`, damit ein gelöschtes Arbeitsverzeichnis das Wiederanbinden nicht verhindert. Nur `new-session` nutzt `LaunchSpec.cwd`.
- **Keepalive-Backoff:** Stirbt ein Keepalive, während Sessions seiner Distro bekannt sind, startet das Backend ihn nach 1 s, 2 s, … höchstens 60 s neu; nach mehr als 30 s Laufzeit beginnt die Wartezeit wieder bei 1 s. `WslBackend.dispose()` beendet alle Keepalives, die tmux-Sessions bleiben.
- **Distro festhalten:** Fehlt `LaunchSpec.distro`, löst `resolveLaunch` sie beim Start auf (konfigurierte, sonst Standard-Distro) und die Registry speichert sie. Ein späteres `wsl --set-default` ändert nicht, wo der Core die Session sucht.
- **Verlorener Client:** Endet eine PTY ohne Exit-Code, prüft die Registry `exists` und hängt eine neue PTY an (höchstens 3 Versuche: sofort, nach 0,5 s, nach 2 s); Zustand, Views und Schreiber bleiben. Erst wenn die Session fehlt oder alle Versuche scheitern, wird sie `Interrupted`. Windows-Backends melden nach dem Ende ihrer PTY `exists = false` und werden wie bisher `Interrupted`.
- **node-pty-Eingabepipe:** node-pty 1.1.0 hängt an die ConPTY-Eingabepipe keinen `error`-Listener. Eingabe an einen gerade beendeten Client scheitert asynchron mit `EAGAIN`; `spawnPty` fängt diesen Fehler ab, sonst beendet er den Core.

## Folgen

- tmux sieht immer nur einen Client, Größenkonflikte zwischen Fenstern entstehen nicht in tmux.
- node-pty 1.1.0 bringt Prebuilds mit und läuft unter Node 25 und unter Electron 45 (auch mit `ELECTRON_RUN_AS_NODE=1`). Ein Bau aus dem Quelltext braucht node-gyp ≥ 12 (VS 2026) und die MSVC-Spectre-Bibliotheken; er ist nicht nötig.
- Wer die Session anzeigt, muss Terminal-Abfragen beantworten (DA1, Cursorposition). Das tut nur die schreibende View; lesende Views verwerfen ihre automatischen Antworten.
