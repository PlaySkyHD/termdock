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
- **Löschen.** Reihenfolge: Workspace suchen (`not_found`), `SessionRegistry.clearWorkspace` (Repository zuerst, dann Speicher; Prozesse laufen weiter, auch archivierte Sessions werden gruppenlos), Workspace löschen (Projekte und Profil-Bindungen über Fremdschlüssel), dann `session.updated` je Session und zuletzt `workspace.changed`. Clients sehen so nie eine Session mit einem Workspace, den `workspace.changed` nicht mehr kennt. Die Registry kennt kein Event dafür; der Server sendet `session.updated` aus der zurückgegebenen Liste über `notifyListers`. `SessionRepository.clearWorkspace` ist ein einziges `UPDATE`, kein Speichern jeder Session.
- **Standardverzeichnis.** `defaultCwd({ project?, workspace?, settings? }): string` liefert den ersten gesetzten Wert aus Projektpfad, `workspace.defaultCwd`, `settings.defaultCwd`, sonst `~`. Eine reine Funktion in `workspace/default-cwd.ts`; die Einstellungen kommen als `Pick<Settings, "defaultCwd">`, weil das Settings-Repository erst mit #60 folgt.
- **IDs** vergibt der Core mit `randomUUID`.
- **Optionale Server-Option.** `CoreServerOptions.workspaces` ist optional (Standard: In-Memory), damit bestehende Tests und parallele Arbeit nicht brechen; `runCore` übergibt das SQLite-Repository über eine Weiterleitung wie bei `layouts`.

## Risks / Trade-offs

- Löschen ist nicht atomar über Sessions und Workspace (zwei Tabellenänderungen, eine Transaktion je Schritt). Ein Fehler zwischen beiden lässt gruppenlose Sessions und einen noch vorhandenen Workspace zurück; das ist harmlos und der Aufruf lässt sich wiederholen.
- Eine Session kann weiter eine unbekannte `workspaceId` tragen (`session.create`); das prüft #57/#58.
