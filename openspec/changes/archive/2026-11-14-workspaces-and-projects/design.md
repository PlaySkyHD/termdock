# Design

## Context

Migration 1 und 3 haben `workspaces` und `projects` samt `default_cwd`, `backend` und `distro` bereits angelegt; `projects.workspace_id` hat `ON DELETE CASCADE`, `launch_profiles` `ON DELETE SET NULL`. `sessions.workspace_id` hat keinen Fremdschlüssel (die Registry kennt Workspace-IDs, bevor sie verwaltet werden). Der Vertrag (#55) liefert Typen, Parser und `validateWorkspace`/`validateProject`.

## Goals / Non-Goals

**Goals:** Workspaces und Projekte persistent verwalten, Änderungen an alle Listen-Clients melden, Löschen ohne Sessions zu beenden, Standardverzeichnis als reine Funktion.

**Non-Goals:** Sidebar, Profile, Einstellungen-Repository, Dateisystemprüfung von Pfaden.

## Decisions

- **Repository speichert ganze Workspaces.** `WorkspaceRepository { list(); save(workspace); delete(id) }`. `save` ersetzt den Workspace samt Projektliste in einer Transaktion (Upsert, nicht mehr enthaltene Projekte löschen, Projekte upserten). Der Dienst liest, führt Änderungen zusammen, prüft das Ganze mit `validateWorkspace` und speichert; ein Projekt-Update ist so dieselbe Operation wie ein Workspace-Update und kann nur gültige Zustände schreiben. Reihenfolge: Anlegereihenfolge (`ORDER BY rowid`; Upsert behält die rowid).
- **Dienst `WorkspaceService` statt Logik im Server.** Er hält die Regeln (Zusammenführen, Grenzen, Pfadsyntax, `not_found`), ist ohne Pipe testbar und gibt Ergebnisse zurück; der Server verteilt die Events. Der Server bleibt dünn, die Stub-cases werden einzeilig.
- **Fehlercodes.** Ungültige Eingabe oder ein ungültiges zusammengeführtes Objekt: `bad_request` (Meldung des Parsers). Unbekannte Workspace- oder Projekt-ID: `not_found`. Zu viele Workspaces (64) oder Projekte (16): `invalid_state`, weil die Anfrage für sich gültig ist und nur der Bestand sie verbietet. Das Byte-Limit eines Workspace kommt aus `validateWorkspace` (`bad_request`).
- **Pfadsyntax.** `wsl`: absoluter Linux-Pfad (beginnt mit `/`). `windows`: Laufwerkspfad (`C:\` oder `C:/`) oder UNC-Pfad (`\\server\share`). Kein Dateisystemzugriff, keine Normalisierung. Geprüft wird das zusammengeführte Projekt, so fällt auch ein Backend-Wechsel ohne neuen Pfad auf. Das `defaultCwd` eines Workspace hat kein Backend und wird nur vom Vertrag geprüft (Länge, kein NUL).
- **Löschen.** Reihenfolge: Workspace suchen (`not_found`), dann `SessionRegistry.clearWorkspace(id, around)`: Der Server übergibt `around`, das `WorkspaceRepository.delete(id, alsoInTransaction)` mit dem Schreiben der Sessions (`SessionRepository.clearWorkspace`, ein einziges `UPDATE`) aufruft. Beides läuft in einer SQLite-Transaktion auf derselben Verbindung (Projekte und Profil-Bindungen über Fremdschlüssel); fehlt der Workspace oder schlägt etwas fehl, wird zurückgerollt. Erst nach dem Commit ändert die Registry ihren Speicher, danach sendet der Server `session.updated` je Session über `notifyListers` und zuletzt `workspace.changed`. Clients sehen so nie eine Session mit einem Workspace, den `workspace.changed` nicht mehr kennt. Prozesse laufen weiter, auch archivierte Sessions werden gruppenlos.
- **Standardverzeichnis.** `defaultCwd({ backend, project?, workspace?, settings? }): string` liefert den ersten gesetzten Wert aus Projektpfad, `workspace.defaultCwd`, `settings.defaultCwd`, dessen Syntax zum Ziel-Backend passt (`projectPathProblem`), sonst `~`. Für `windows` ist `~` ein dokumentierter Platzhalter, bis das Windows-Backend (#65) einen eigenen Fallback festlegt. Das `defaultCwd` eines Workspace wird beim Anlegen und Ändern nicht gegen ein Backend geprüft, weil der Workspace keines hat; der Filter greift erst beim Anlegen einer Session. Eine reine Funktion in `workspace/default-cwd.ts`; die Einstellungen kommen als `Pick<Settings, "defaultCwd">`, weil das Settings-Repository erst mit #60 folgt.
- **Sessions nur in bestehenden Workspaces.** `session.create` prüft eine `workspaceId` mit `WorkspaceService.assertWorkspace` (`not_found`), sonst bliebe eine Session an einem gelöschten Workspace hängen, den kein Löschen mehr ungruppiert.
- **IDs** vergibt der Core mit `randomUUID`.
- **Optionale Server-Option.** `CoreServerOptions.workspaces` ist optional (Standard: In-Memory), damit bestehende Tests und parallele Arbeit nicht brechen; `runCore` übergibt das SQLite-Repository über eine Weiterleitung wie bei `layouts`.

## Risks / Trade-offs

- `session.create` ohne `launch` (Profil) bleibt bis #58 ein Stub; die Workspace-Prüfung davor gilt schon.
