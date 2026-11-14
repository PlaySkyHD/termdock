# Design

## Context

Migration 3 hat `launch_profiles` angelegt (`workspace_id` und `project_id` mit `ON DELETE SET NULL`). Der Vertrag (#55) liefert `LaunchProfile`, `validateLaunchProfile`, `MAX_PROFILES`, `MAX_PROFILE_BYTES` und `session.create` ohne `launch` bei gesetzter `profileId`. #56 liefert `WorkspaceService` und `defaultCwd`.

## Goals / Non-Goals

**Goals:** Profile persistent verwalten, Änderungen melden, Sessions aus Profilen anlegen, die Bindung an Projekt und Workspace konsistent halten.

**Non-Goals:** Autostart-Auswertung (P3-6), Editor (P3-9), Settings-Repository (#60), Dateisystemprüfung.

## Decisions

- **Repository speichert ganze Profile.** `ProfileRepository { list(); save(profile); delete(id) }`, Upsert behält die `rowid` (Anlegereihenfolge). `command` und `env` liegen als JSON in ihren Spalten, wie bei `sessions`.
- **Dienst `ProfileService` statt Logik im Server.** Er führt Änderungen zusammen (`null` entfernt `workspaceId`/`projectId`), prüft die Bindung, validiert das Ganze mit `validateLaunchProfile` (`bad_request`) und speichert. Grenze 64 Profile: `invalid_state`. Unbekannte Profil-, Workspace- oder Projekt-ID: `not_found`.
- **Bindung.** Die Invariante aus `session-persistence` („Workspace eines Profils mit Projekt ist der Workspace dieses Projekts“) gilt beim Anlegen und Ändern. Fehlt `workspaceId` bei gesetztem `projectId`, setzt der Core ihn auf den Workspace des Projekts; eine abweichende `workspaceId` ergibt `bad_request`. `workspaceId: null` bei bleibendem Projekt ergibt `bad_request`, statt den Wert stillschweigend wieder zu füllen; wer den Workspace wechselt, setzt `projectId: null` mit.
- **Bindung lesen.** `ProfileService.list` blendet Bindungen aus, die der `WorkspaceService` nicht mehr kennt. In SQLite entfernen die Fremdschlüssel sie ohnehin; so antwortet auch das In-Memory-Repository (ohne Fremdschlüssel) gleich, ohne dass Repositories einander kennen.
- **`session.create` mit `profileId`.** Der Server lädt das Profil (auch bei ausdrücklichem `launch`, damit eine unbekannte `profileId` `not_found` ergibt und `profileId` nie auf nichts zeigt). Ohne `launch`: Spec des Profils. Mit `launch`: dieses ersetzt den Spec als Ganzes, kein Zusammenführen. `loggingEnabled` der Anfrage vor dem des Profils.
- **Fehlendes `cwd` = `~`.** `LaunchProfile.launch.cwd` ist laut Vertrag Pflicht (1 bis 512 Zeichen); „kein eigenes Verzeichnis“ drückt ein Profil mit `cwd: "~"` aus (der Fallback von `defaultCwd`). Nur dann wird `defaultCwd({ backend, project, workspace, settings })` mit Projekt und Workspace des Profils angewendet; jedes andere `cwd` bleibt unverändert. Die Einstellungen sind bis #60 `DEFAULT_SETTINGS` (ohne `defaultCwd`) und werden mit dem Settings-Repository verdrahtet.
- **Events.** `profile.changed` nach jeder gespeicherten Änderung über `notifyListers`, nach `workspace.delete` und `project.delete` zusätzlich nach `workspace.changed`. Er wird dort immer gesendet, auch wenn kein Profil gebunden war: das ist billig und der Server muss die Bindungen dafür nicht vorher lesen.
- **Sicherheit.** `launch.command` bleibt ein Argument-Array bis zum Backend; der Core baut daraus nie einen Shell-String. `env` hat keine Geheimnisse; Zugangsdaten kommen aus bestehenden CLI-Logins.
- **Optionale Server-Option.** `CoreServerOptions.profiles` (Standard: In-Memory); `runCore` übergibt das SQLite-Repository über eine Weiterleitung wie bei den Workspaces.

## Risks / Trade-offs

- `cwd: "~"` als Marker ist eine Konvention über dem Vertrag; ein Profil, das wirklich das Home-Verzeichnis will, bekommt bei gesetztem Projekt dessen Pfad. Ein Vertragsfeld `cwd?` wäre sauberer, braucht aber eine Vertragsänderung (#55).
- Zwei Anfragen `workspace.delete` und `profile.create` mit demselben Workspace laufen nicht parallel (ein Event-Loop, synchrone Dienste); die Prüfung und das Speichern eines Profils sind synchron.
