# ADR 0003: Backends und Datenfluss zum Terminal

Status: angenommen (13.11.2026), wird durch Phase 0 (PoC) bestätigt oder korrigiert

## Kontext

Dieselbe Session soll in mehreren Fenstern sichtbar sein, aber nur eine View schreibt und bestimmt die Größe (Kapitel 7). WSL-Sessions sollen über tmux langlebig sein (Kapitel 4).

## Entscheidung

- **Eine PTY pro Session im Core, nicht pro View.** Der Core hält für jede laufende Session genau eine PTY (node-pty/ConPTY). Er verteilt deren Ausgabe als `session.output`-Events an alle Views der Session. Views sind reine Darsteller (xterm.js).
- **WSL-Backend:** Die PTY führt `wsl.exe -d <distro> --cd <linux-verzeichnis> -- tmux -L termdock new-session -A -s td-<sessionId> [befehl]` aus (Argument-Array). Eigener tmux-Socket `termdock`, damit Nutzer-tmux unberührt bleibt. tmux-Option `status off` für die verwaltete Session. Wiederanbinden = neue PTY mit `tmux -L termdock attach-session -t td-<sessionId>`. Existenzprüfung über `tmux -L termdock has-session -t td-<sessionId>` (ohne PTY, per `execFile`).
- **Windows-Backend:** Die PTY führt die Shell direkt aus (`pwsh.exe`, `powershell.exe`, `cmd.exe`). Persistenz nur so lange wie der Core läuft (ADR 0001).
- **Snapshot für neue Views:** Beim `session.attach` liefert der Core einen Snapshot: bei WSL `tmux capture-pane -p -e -J -S -<n>` des sichtbaren Bereichs plus Cursorposition, bei Windows den Inhalt eines begrenzten Rohdaten-Puffers im Core (256 KiB je Session). Danach folgen Live-Events.
- **Größe:** Nur die schreibende View sendet `session.resize`. Der Core ändert die PTY-Größe (tmux folgt dem einzigen Client). Lesende Views bekommen die maßgebliche Größe mit `session.resized` und stellen das Terminal in dieser Größe dar (skaliert oder beschnitten, Entscheidung in Phase 2).
- **Backend-Schnittstelle** (`packages/core/src/backend/types.ts`): `start`, `attach`, `exists`, `kill`, plus eine `PtyHandle` mit `write`, `resize`, `onData`, `onExit`, `dispose`. Tests nutzen `FakeBackend`.

## Folgen

- tmux sieht immer nur einen Client, Größenkonflikte zwischen Fenstern entstehen nicht in tmux.
- Risiko: node-pty muss für die Node-/Electron-Version des Core bauen oder Prebuilds haben. Phase 0 prüft das.
