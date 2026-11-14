# Proposal

## Why

Die Verträge der Phase 3 (#55) und die Workspaces (#56) liegen vor, der Core beantwortet `profile.*` aber noch mit `internal` („noch nicht umgesetzt“), und `session.create` ohne `launch` ebenso. Ohne Startprofile lassen sich Claude Code, Codex oder `dotnet watch` nicht per Klick starten, und Autostart (P3-6) hat nichts, was er starten könnte (Konzept Kap. 9; Abnahme 02, 03; Issue #58).

## What Changes

- Neues `ProfileRepository` (SQLite auf `launch_profiles`, In-Memory) und `ProfileService` mit `profile.list|create|update|delete`. Jede gespeicherte Änderung sendet `profile.changed` mit der vollständigen Liste an alle Listen-Clients.
- Prüfung der Bindung: Ein Profil mit `projectId` hat den Workspace dieses Projekts (fehlt `workspaceId`, füllt der Core ihn); unbekannte IDs ergeben `not_found`, ein Projekt eines anderen Workspace `bad_request`. Das zusammengeführte Profil wird mit `validateLaunchProfile` geprüft; höchstens 64 Profile.
- `session.create` mit `profileId`: Der Core übernimmt den `LaunchSpec` des Profils, ein ausdrückliches `launch` ersetzt ihn als Ganzes. Hat das Profil `cwd: "~"` (kein eigenes Verzeichnis), gilt `defaultCwd(...)` aus #56 mit Projekt und Workspace des Profils. `loggingEnabled` des Profils ist der Standard der Session. Ein unbekanntes Profil ergibt `not_found`.
- Löschen eines Workspace oder Projekts lässt Profile über die Fremdschlüssel ihre Bindung verlieren; der Core sendet danach zusätzlich `profile.changed`.
- Der Stub-Zweig „session.create ohne launch“ und die Stubs `profile.*` entfallen.

## Capabilities

### New Capabilities

- `launch-profiles`: Startprofile im Core (Verwaltung, Bindung, Anlegen von Sessions aus einem Profil, Meldung von Änderungen, Persistenz).

### Modified Capabilities

- `core-ipc`: Die Liste der Platzhalter („Platzhalter für Methoden der Phase 3“) verliert `profile.*` und `session.create` ohne `launch`.

## Impact

- `packages/core`: `storage/profile-repository.ts`, `storage/database.ts`, `workspace/profile-service.ts`, `ipc/server.ts` (nur die Zweige `session.create`, `profile.*` und je eine Zeile in `workspace.delete` und `project.delete`), `bin/run-core.ts` (Weiterleitung auf den Speicher).
- Nicht angefasst: `apps/desktop`, `packages/protocol`. Dependencies: keine neuen.
- Security: `launch.command` ist ein Argument-Array und wird nie zu einem Shell-String zusammengesetzt; `launch.env` enthält keine Geheimnisse, Zugangsdaten kommen aus bestehenden CLI-Logins.
- Breaking Changes: keine. `CoreServerOptions.profiles` ist optional (Standard: In-Memory).
- Non-Goals: Autostart-Logik (P3-6), Profil-Editor (P3-9), Einstellungen-Repository (#60).
