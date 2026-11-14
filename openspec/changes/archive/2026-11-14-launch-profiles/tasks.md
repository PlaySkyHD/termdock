# Tasks

## 1. Speicher

- [x] 1.1 Test und Umsetzung: `ProfileRepository` (SQLite und In-Memory): Anlegen, Ersetzen mit gleicher Reihenfolge, Löschen, Neustart, Bindung fällt mit dem Workspace weg (`profile-repository.test.ts`, `profile-repository.ts`, `database.ts`)

## 2. Dienst

- [x] 2.1 Umsetzung: `ProfileService` mit Zusammenführen, Bindungsprüfung, Validierung, Grenze, `not_found`, `launchFor`; getestet über die Pipe in 3.1 (`profile-service.ts`)

## 3. IPC

- [x] 3.1 Test und Umsetzung: Server beantwortet `profile.*`, sendet `profile.changed` an Listen-Clients (nicht an andere, nicht bei abgelehnten Anfragen), prüft die Bindung, sendet es auch nach `workspace.delete` und `project.delete` (`ipc.test.ts`, `server.ts`)
- [x] 3.2 Test und Umsetzung: `session.create` mit `profileId` übernimmt Spec und Logging-Schalter, ein ausdrückliches `launch` ersetzt den Spec, unbekanntes Profil ergibt `not_found`, `cwd: "~"` folgt der Rangfolge Projekt, Workspace, `~` (`ipc.test.ts`, `server.ts`)
- [x] 3.3 Test und Umsetzung: `runCore` verbindet den Speicher, Profile überleben einen Neustart und verlieren ihre Bindung (`run-core.test.ts`, `run-core.ts`)
- [x] 3.4 Test: WSL-Integrationstest, Profil mit `command: ["bash", "-lc", "pwd; exec bash"]` startet im Projektverzeichnis und im eigenen `cwd` (`e2e.wsl.test.ts`, mit `TERMDOCK_WSL_TESTS=1`)
