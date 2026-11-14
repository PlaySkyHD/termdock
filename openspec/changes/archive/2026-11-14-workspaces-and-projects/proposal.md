# Proposal

## Why

Die Verträge der Phase 3 (#55) liegen vor, der Core beantwortet `workspace.*` und `project.*` aber noch mit `not_implemented`. Ohne Workspaces und Projekte im Core kann die Sidebar (P3-8) keine Gruppen zeigen, und Profile (P3-3) haben nichts, woran sie sich binden (Konzept Kap. 2, 3, 5; Abnahme 01, 12; Issue #56).

## What Changes

- Neues `WorkspaceRepository` (SQLite und In-Memory) auf den Tabellen `workspaces` und `projects`; neue `workspace.list|create|update|delete` und `project.create|update|delete` im Server. Jede Änderung sendet `workspace.changed` an alle Listen-Clients.
- Das zusammengeführte Workspace-Objekt wird vor dem Speichern mit `validateWorkspace` geprüft; Grenzen (`MAX_WORKSPACES`, `MAX_PROJECTS_PER_WORKSPACE`, `MAX_WORKSPACE_BYTES`) gelten im Core.
- Projektpfade werden je Backend syntaktisch geprüft (Linux-Pfad für `wsl`, Windows-Pfad für `windows`), ohne Dateisystemzugriff.
- Löschen eines Workspace lässt seine Sessions laufen und macht sie gruppenlos: neue `SessionRegistry.clearWorkspace`, je Session `session.updated`, danach `workspace.changed`. Profile verlieren die Bindung über die Fremdschlüssel aus Migration 3.
- Reine Funktion `defaultCwd(...)`: Projekt, dann Workspace, dann Einstellung, dann `~`. P3-3 nutzt sie beim Anlegen von Sessions ohne `cwd`.

## Capabilities

### New Capabilities

- `workspaces`: Workspaces und Projekte im Core (Verwaltung, Pfadprüfung, Löschen mit Sessions, Standardverzeichnis, Persistenz).

### Modified Capabilities

(keine; die Anforderung „Bindungen an Workspaces“ in `session-persistence` nennt dieses Verhalten bereits und wird von `workspaces` umgesetzt)

## Impact

- `packages/core`: `storage/workspace-repository.ts`, `storage/database.ts`, `storage/session-repository.ts` (`clearWorkspace`), `session/registry.ts` (`clearWorkspace`), `workspace/` (Pfadprüfung, Dienst, `defaultCwd`), `ipc/server.ts` (nur die Stub-cases `workspace.*`, `project.*`), `bin/run-core.ts` (Weiterleitung auf den Speicher).
- Nicht angefasst: `apps/desktop`, `packages/protocol`. Dependencies: keine neuen.
- Security: Pfade werden nur als Text geprüft, nie geöffnet; die Methoden laufen über die bestehende Pipe (nur aktueller Benutzer, ADR 0002).
- Breaking Changes: keine. `CoreServerOptions.workspaces` ist optional (Standard: In-Memory).
- Non-Goals: Sidebar (P3-8), Profile (P3-3), Einstellungen (P3-6).
