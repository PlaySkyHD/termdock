# ADR 0004: Speicher und Format des Verlaufs

Status: angenommen (13.11.2026)

## Kontext

Metadaten brauchen eine robuste lokale Ablage (Kapitel 4). Der persistente Verlauf ist standardmäßig auf 10 MiB je Session begrenzt, abschaltbar und wird beim Löschen entfernt (Kapitel 8).

## Entscheidung

- **Ablage:** `%APPDATA%\TermDock\` (in Tests ein Temp-Verzeichnis über `TERMDOCK_DATA_DIR`).
- **Metadaten:** SQLite über das eingebaute `node:sqlite` (keine native Zusatzabhängigkeit). Datei `termdock.db`, WAL-Modus. Schema-Migrationen als nummerierte SQL-Schritte mit Tabelle `schema_version`.
- **Tabellen (Phase 1):** `sessions` (id, name, backend, distro, shell, cwd, command, env, state, workspace_id, profile_id, cols, rows, created_at, updated_at, last_exit_code, logging_enabled), `workspaces`, `projects`, `layouts` (JSON des Fenster-/Tab-/Split-Layouts). Das globale Layout ist die Zeile `id = global` mit `workspace_id` NULL; Migration 2 ergänzt `layouts.revision` (0 ohne Speichern, +1 je `layout.save`) für den Abgleich über `baseRevision` (ADR 0002). Das Dokument (`LayoutDocument` in `packages/protocol`) hat höchstens 4 Panes je Tab; Sessions, die es nicht mehr gibt, bleiben darin stehen. `shell`, `env` (JSON) und die Größe (`cols`, `rows`) ergänzen die ursprüngliche Liste, damit `LaunchSpec` und Terminalgröße nach einem Core-Neustart vollständig wiederherstellbar sind; `command` ist ein JSON-Array. Views und Schreiber werden nicht gespeichert. Profile und Verlauf-Metadaten in Phase 3.
- **Verlauf:** Ringpuffer aus zwei Segmentdateien je Session, `history/<sessionId>/a.log` und `b.log`. Ist das aktive Segment voll (Limit / 2), wird das andere geleert und aktiv. Damit liegt der Plattenverbrauch je Session nie über dem Limit und es bleiben immer mindestens Limit / 2 der jüngsten Ausgabe erhalten. Jeder Eintrag: `uint64 BE Zeitstempel ms | uint32 BE Länge | Rohbytes`. Suche entfernt Escape-Sequenzen erst beim Lesen.
- Verlauf ist pro Session abschaltbar (`logging_enabled`). Löschen einer Session entfernt `history/<sessionId>/`.

## Folgen

- Kein separater Datenbankprozess, kein Native-Build für SQLite.
- `node:sqlite` braucht Node ≥ 22.13 (ab 22.5 nur mit `--experimental-sqlite`); Electron-Version entsprechend wählen. Das Modul gibt weiterhin eine `ExperimentalWarning` aus.
