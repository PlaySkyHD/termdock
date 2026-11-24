# Proposal

## Why

V1-15 („Windows-Shells funktionieren mit erkennbaren Persistenzgrenzen“) ist das letzte offene Abnahmekriterium (#65). Protokoll, Profile und Projekte kennen `backend: "windows"` mit `shell` schon, der Core hat aber kein Windows-Backend: Eine solche Session scheitert mit „No backend for kind windows“. Die Oberfläche bietet nur WSL an und sagt nirgends, dass eine Windows-Shell im Core läuft und mit ihm endet.

## What Changes

- Neues `WindowsBackend` (`packages/core/src/backend/windows/`): `pwsh`, `powershell`, `cmd` über node-pty/ConPTY (`useConptyDll`), als Argument-Array, mit klarer Meldung bei fehlender Shell, Benutzerordner und Warnung `cwd_missing` bei fehlendem Verzeichnis, ohne `ELECTRON_RUN_AS_NODE` in der Shell.
- Gemeinsamer ConPTY-Code zieht von `backend/wsl/` nach `backend/conpty/` (`spawnConpty`, Leser, Schließ-Schlange, `ConptyPty`, früher `WslPty`). Ein Verlust der Ausgabe ist am Ende-Ereignis erkennbar (`lost`).
- Lifecycle: Ende der Shell → `Exited` mit Exit-Code, Verlust → `Interrupted`, Core-Neustart → `Interrupted`, `session.restart` mit Trennzeile, Archivieren beendet die Shell, Autostart mit Windows-Profilen, keine doppelte Shell. `core.shutdown` ohne Stop beendet die Shells.
- Die Registry gibt den Text eines `CoreError` des Backends beim gescheiterten Start an den Client weiter.
- Desktop: Formular „Neue Session“ mit Backend und Shell, Projektdialog mit Backend, Badge „Win“ und Tooltip in der Sidebar, Hinweis in der Statusleiste, Text der unterbrochenen Windows-Session, Hinweis im Schließen-Dialog, Hinweis beim Profil, Warnungstext für den Benutzerordner.
- `--smoke-test` startet eine Windows-Shell im Paket und prüft ihren Exit-Code.
- Neue Screenshot-Gruppe `windows` (`34`–`39`). V1-15 wird erfüllt.
- Nachträge in ADR 0001, 0003, 0005 und 0008.

## Capabilities

### New Capabilities

- `windows-backend`: Start, Shells, Verzeichnis, Umgebung, Ende, Kill und Abbau der Windows-Sessions.

### Modified Capabilities

- `session-lifecycle`: Fehlertext beim gescheiterten Start (ADDED), Windows-Sessions im Lifecycle (ADDED).
- `desktop-shell`: „Neue WSL-Session aus der Sidebar“ wird „Neue Session aus der Sidebar“ (RENAMED, MODIFIED), Projektdialog mit Backend und Szenengruppen-Liste (MODIFIED), Persistenzgrenze sichtbar, Schließen-Dialog nennt Windows-Shells, Szenen der Gruppe `windows` (ADDED).
- `workspaces`: `~` ist für `windows` der Benutzerordner (MODIFIED).
- `packaging`: Prüfmodus startet eine Windows-Shell (ADDED).

V1-15 steht danach als erfüllt in `docs/acceptance.md`; die Capability `acceptance` (der Mechanismus) bleibt unverändert.

## Impact

- Pakete: `packages/core` (neues `backend/windows/`, neues `backend/conpty/`, `backend/wsl/processes.ts`, `backend.ts`, `session/registry.ts`, `bin/run-core.ts`, `index.ts`), `apps/desktop` (Renderer, `quit-*`, `smoke-test.ts`, `main.ts`, neue Szene), `scripts/pty-shutdown-repro.mjs`.
- Protokoll und Datenmodell: unverändert. Die Brücke bekommt ein optionales Feld `windowsSessions` in `quitRequested`.
- Abhängigkeiten: keine neue.
- Security: Argument-Arrays, `PATH` nur mit absoluten Verzeichnissen, keine Shell-Strings, `ELECTRON_RUN_AS_NODE` nicht in der Shell.
- Non-Goals: Persistenz von Windows-Shells über den Core hinaus; `.cmd`-Dateien als `command` ohne ausdrückliches `cmd.exe /c`.
- Breaking Changes: keine.
