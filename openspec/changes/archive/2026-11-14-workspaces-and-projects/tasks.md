# Tasks

## 1. Speicher

- [x] 1.1 Test und Umsetzung: `WorkspaceRepository` (SQLite und In-Memory): Anlegen, Ändern, Projekte, Reihenfolge, Löschen mit Kaskade, Neustart, Profil-Bindung fällt weg (`workspace-repository.test.ts`, `workspace-repository.ts`, `database.ts`)
- [x] 1.2 Test und Umsetzung: `SessionRepository.clearWorkspace` setzt nur die Sessions des Workspace auf gruppenlos (`session-repository.test.ts`, `session-repository.ts`)

## 2. Registry und Dienst

- [x] 2.1 Test und Umsetzung: `SessionRegistry.clearWorkspace` liefert die geänderten Sessions, Prozesse laufen weiter, Speicher und Repository gleich (`registry.test.ts`, `registry.ts`)
- [x] 2.2 Test und Umsetzung: Pfadsyntax je Backend (`workspace/paths.test.ts`, `paths.ts`)
- [x] 2.3 Test und Umsetzung: reine Funktion `defaultCwd` mit Rangfolge (`workspace/default-cwd.test.ts`, `default-cwd.ts`)
- [x] 2.4 Umsetzung: `WorkspaceService` mit Zusammenführen, Validierung, Grenzen, `not_found`; getestet über die Pipe in 3.1 (`service.ts`)

## 3. IPC

- [x] 3.1 Test und Umsetzung: Server beantwortet `workspace.*` und `project.*`, sendet `workspace.changed` an einen zweiten Client, löscht mit `session.updated` vor `workspace.changed`; `runCore` verbindet den Speicher (`ipc.test.ts`, `run-core.test.ts`, `server.ts`, `run-core.ts`)
