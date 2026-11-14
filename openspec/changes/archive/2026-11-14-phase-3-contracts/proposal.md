# Proposal

## Why

Phase 3 (Konzept Kap. 12: Startprofile, Autostart, Gruppen ohne Projekt, Archiv/Löschung, Verlauf, Suche, Einstellungen) wird in neun Issues (#56–#64) parallel gebaut. Ohne gemeinsame Verträge ändern alle dieselben Stellen in `messages.ts`, `guards.ts`, `migrations.ts` und `server.ts` und kollidieren. Issue #55 legt Typen, Methoden, Events, Protokoll 1.3 und Migration 3 vorab fest; die Fach-Issues ersetzen nur noch ihre Stubs.

## What Changes

- **Gemeinsame Typen** in `packages/protocol/src/model.ts`: `Workspace`, `Project`, `LaunchProfile`, `Settings` (feste Schlüssel, Standardwerte), `SettingsPatch`, `HistoryHit`, `QuitAction` und Grenzen als Konstanten (Namens- und Pfadlänge, Anzahl Workspaces, Projekte, Profile, Profilgröße, Verlaufslimit, Suchlänge, Treffer).
- **Neue Methoden** mit Guards: `workspace.list|create|update|delete`, `project.create|update|delete`, `profile.list|create|update|delete`, `session.update`, `session.archive`, `session.delete`, `settings.get|set`, `history.search`.
- `session.create`: `launch` wird optional, wenn `profileId` gesetzt ist (Anlegen aus Profil, #58). Ohne beides bleibt `launch` Pflicht.
- **Neue Events:** `workspace.changed { workspaces }`, `profile.changed { profiles }`, `session.updated { session }`, `session.removed { sessionId }`, `settings.changed { settings }`. Empfänger wie bei `session.created`: Verbindungen, die `session.list` genutzt haben.
- `PROTOCOL_VERSION` wird `1.3` (nur neue Methoden, Events und ein optional gewordenes Feld).
- **Migration 3:** Tabellen `launch_profiles` und `settings` (Schlüssel, JSON-Wert), Spalten `projects.backend` (Standard `wsl`), `projects.distro`, `workspaces.default_cwd`, Index `sessions_profile`.
- **Core:** je neuer Methode ein eigener Stub-Abschnitt im Dispatch, der mit `internal` „noch nicht umgesetzt“ antwortet; ebenso `session.create` ohne `launch`. Ein Sendeweg für die neuen Events an Listen-Clients.
- ADR 0002 (Methoden, Events, Version 1.3) und ADR 0004 (Tabellen der Phase 3).

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `ipc-protocol`: „Ausgabesequenz im Vertrag“ (Version 1.3), „Events“ (neue Events); neue Anforderungen zu den Phase-3-Typen, -Methoden, -Grenzen und zum Anlegen aus Profil.
- `session-persistence`: „Ablage und Schema“ (neue Tabellen); neue Anforderung „Schema der Phase 3“ mit Migration 2 → 3.
- `core-ipc`: neue Anforderungen „Platzhalter für Methoden der Phase 3“ und „Empfänger der Phase-3-Events“ (Verhalten des Servers, gehört nicht in den reinen Vertrag).

## Impact

- Pakete: `packages/protocol` (`model.ts`, `messages.ts`, `guards.ts`), `packages/core` (`storage/migrations.ts`, `ipc/server.ts`). `apps/desktop` nur, falls der Typecheck durch die Version bricht.
- IPC-Methoden: 18 neue, `session.create` erweitert. Datenmodell: drei geänderte, zwei neue Tabellen.
- Phase: 3 (Welle 0, Konzept Kap. 12).
- Non-Goals: Fachlogik der Methoden (#56–#64), Repositories, Desktop-UI, Windows-Backend (#65).
- Security: Alles läuft über die bestehende Pipe (nur aktueller Benutzer, ADR 0002). Neue Eingaben haben Längen- und Mengengrenzen, unbekannte Felder in neuen Anfragen werden abgelehnt. `env` in Profilen bleibt ohne Secrets (security.instructions.md); das steht am Typ.
- Breaking Changes: keine. Bestehende Methoden und Events bleiben gleich; ein 1.2-Client ignoriert unbekannte Events und ruft die neuen Methoden nicht auf. Migration 3 behält alle Bestandsdaten.
