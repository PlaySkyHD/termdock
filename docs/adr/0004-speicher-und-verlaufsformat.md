# ADR 0004: Speicher und Format des Verlaufs

Status: angenommen (13.11.2026)

## Kontext

Metadaten brauchen eine robuste lokale Ablage (Kapitel 4). Der persistente Verlauf ist standardmäßig auf 10 MiB je Session begrenzt, abschaltbar und wird beim Löschen entfernt (Kapitel 8).

## Entscheidung

- **Ablage:** `%APPDATA%\TermDock\` (in Tests ein Temp-Verzeichnis über `TERMDOCK_DATA_DIR`).
- **Metadaten:** SQLite über das eingebaute `node:sqlite` (keine native Zusatzabhängigkeit). Datei `termdock.db`, WAL-Modus. Schema-Migrationen als nummerierte SQL-Schritte mit Tabelle `schema_version`.
- **Tabellen (Phase 1):** `sessions` (id, name, backend, distro, shell, cwd, command, env, state, workspace_id, profile_id, cols, rows, created_at, updated_at, last_exit_code, logging_enabled), `workspaces`, `projects`, `layouts` (JSON des Fenster-/Tab-/Split-Layouts). Das globale Layout ist die Zeile `id = global` mit `workspace_id` NULL; Migration 2 ergänzt `layouts.revision` (0 ohne Speichern, +1 je `layout.save`) für den Abgleich über `baseRevision` (ADR 0002). Das Dokument (`LayoutDocument` in `packages/protocol`) hat höchstens 4 Panes je Tab; Sessions, die es nicht mehr gibt, bleiben darin stehen. `shell`, `env` (JSON) und die Größe (`cols`, `rows`) ergänzen die ursprüngliche Liste, damit `LaunchSpec` und Terminalgröße nach einem Core-Neustart vollständig wiederherstellbar sind; `command` ist ein JSON-Array. Views und Schreiber werden nicht gespeichert.
- **Tabellen (Phase 3, Migration 3, #55):** `launch_profiles` (id, name, workspace_id, project_id, backend, distro, shell, cwd, command, env, autostart, logging_enabled, created_at, updated_at; `command` und `env` als JSON wie bei `sessions`, Fremdschlüssel auf Workspace und Projekt mit `ON DELETE SET NULL`), `settings` (key, value als JSON; ein fehlender Schlüssel hat seinen Standardwert, z. B. `historyLimitBytes` = 10 MiB). `projects` bekommt `backend` (Standard `wsl`) und `distro`, `workspaces` bekommt `default_cwd`, `sessions` den Index `sessions_profile` (Autostart, ADR 0005). Löschen eines Workspace löscht seine Projekte und lässt Profile ungebunden; Löschen nur eines Projekts entfernt nur `project_id`. `sessions.workspace_id` und `sessions.profile_id` haben keinen Fremdschlüssel (SQLite kann ihn nicht nachträglich anlegen): Beim Löschen eines Workspace setzt der Core `workspace_id` seiner Sessions auf NULL und sendet je Session `session.updated` (#56). Hat ein Profil ein `project_id`, muss `workspace_id` der Workspace dieses Projekts sein; der Core prüft das beim Anlegen und Ändern (#58), ein zusammengesetzter Fremdschlüssel ist dafür nicht nötig. Der Verlauf selbst liegt nicht in der Datenbank (siehe unten).
- **Verlauf:** Ringpuffer aus zwei Segmentdateien je Session, `history/<sessionId>/a.log` und `b.log`. Ist das aktive Segment voll (Limit / 2), wird das andere geleert und aktiv. Damit liegt der Plattenverbrauch je Session nie über dem Limit und es bleiben immer mindestens Limit / 2 der jüngsten Ausgabe erhalten. Jeder Eintrag: `uint64 BE Zeitstempel ms | uint32 BE Länge | Rohbytes`. Suche entfernt Escape-Sequenzen erst beim Lesen. Umsetzung (#59): Einträge tragen höchstens 16 KiB Daten (längere Ausgabe wird geteilt); das jüngere Segment ist das mit dem jüngeren Zeitstempel des ersten Eintrags; geschrieben wird im Hintergrund aus einer auf 1 MiB je Session begrenzten Warteschlange, bei Rückstau werden die ältesten wartenden Einträge verworfen und gezählt; ein abgeschnittener letzter Eintrag wird beim Lesen übersprungen und vor dem Weiterschreiben abgeschnitten.
- Verlauf ist pro Session abschaltbar (`logging_enabled`). Löschen einer Session entfernt `history/<sessionId>/`.

## Folgen

- Kein separater Datenbankprozess, kein Native-Build für SQLite.
- `node:sqlite` braucht Node ≥ 22.13 (ab 22.5 nur mit `--experimental-sqlite`); Electron-Version entsprechend wählen. Das Modul gibt weiterhin eine `ExperimentalWarning` aus.
