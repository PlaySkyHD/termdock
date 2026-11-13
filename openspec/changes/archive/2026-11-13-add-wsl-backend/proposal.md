# Proposal

## Why

Der Core kann Sessions bisher nur mit dem `FakeBackend` betreiben. Für langlebige WSL-Sessions (Kapitel 4, Phase 1 – Kernsystem, Kapitel 12) braucht er ein echtes Backend, das tmux in WSL über eine PTY steuert, Sessions über das Ende der PTY hinaus am Leben hält und sie wieder anbindet. Phase 0 (`docs/poc/phase-0-bericht.md`) hat die Aufrufe, die node-pty-Variante und die nötigen Fallstricke (Keepalive, DA1, `status off`, `-T RGB`) belegt.

## What Changes

- Neues WSL-Backend `WslBackend` in `packages/core/src/backend/wsl/`, implementiert die vorhandene Schnittstelle `Backend` (`start`, `attach`, `exists`, `kill`, `snapshot`, `available`).
- Start und Wiederanbinden über `wsl.exe -d <distro> --cd <linux-pfad> --exec tmux -L <socket> -T RGB ...` als Argument-Array; tmux-Socket konfigurierbar (produktiv `termdock`, Tests `termdock-test`).
- PTY über `node-pty` 1.1.0 mit `useConptyDll: true`; die PTY beantwortet die erste DA1-Abfrage der ConPTY selbst, solange von außen keine DA1-Antwort kam.
- Exit-Code des Programms in der tmux-Session über `remain-on-exit` und `#{pane_dead_status}`.
- Keepalive je Distro (`wsl.exe -d <distro> --exec sleep infinity`), solange das Backend Sessions dieser Distro kennt.
- Ermittlung der Standard-Distro über `wsl.exe -l -v`, Hilfsfunktion `wslPath` für Windows-Pfade.
- Keine Breaking Changes: neue Exporte am Ende von `packages/core/src/index.ts`.

## Capabilities

### New Capabilities

- `wsl-backend`: Starten, Wiederanbinden, Prüfen, Beenden und Snapshot von WSL-Sessions über tmux, Exit-Code, Keepalive je Distro.

### Modified Capabilities

(keine)

## Impact

- Paket `packages/core`: neues Verzeichnis `src/backend/wsl/`, Exporte in `src/index.ts`, neue Dependency `node-pty` 1.1.0 (exakt gepinnt, Begründung in `design.md`).
- Unverändert: `backend/types.ts`, `session/registry.ts`, `packages/protocol` (insbesondere `LaunchSpec`, `TerminalSize`). IPC-Methoden: keine neuen.
- Datenmodell: keine Änderung. `LaunchSpec.cwd` ist für WSL ein Linux-Pfad (auch `~`), `LaunchSpec.distro` optional.
- Non-Goals: Windows-Backend, Reconcile beim Core-Start, automatisches Reattach nach verlorenem tmux-Client (Folgeaufgabe in der Registry), Scrollback im Snapshot, Umrechnen von Projektpfaden außer `wslPath`.
- Security: alle Aufrufe von `wsl.exe` und `tmux` als Argument-Array mit `--exec` (keine Login-Shell), Session-Namen und Umgebungsvariablen-Namen werden geprüft, ein einzelnes Befehlsargument wird nicht von einer Shell interpretiert. Eigener tmux-Socket lässt Nutzer-tmux unberührt.
