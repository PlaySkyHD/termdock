# Proposal

## Why

Die Session Registry hält Sessions bisher nur im Speicher. Nach einem Neustart des Core sind alle Sessions verloren, und verlorene Prozesse können nicht als `Interrupted` erkannt werden (Abnahme 9, Kapitel 6). Phase 1 (Kapitel 12) verlangt nach dem Kernsystem die Persistenz der Workspace-/Session-Metadaten (ADR 0004) und das Reconcile beim Core-Start (ADR 0005).

## What Changes

- Neuer Storage im Core (`packages/core/src/storage/`): SQLite über das eingebaute `node:sqlite`, Datei `termdock.db` im Datenverzeichnis (`TERMDOCK_DATA_DIR`, sonst `%APPDATA%\TermDock`), WAL-Modus, nummerierte Migrationen mit Tabelle `schema_version`, Tabellen `sessions`, `workspaces`, `projects`, `layouts`.
- Neue Schnittstelle `SessionRepository` mit SQLite- und In-Memory-Implementierung.
- Die Registry erhält die optionale Option `repository` und schreibt jede Zustands- und Metadatenänderung einer Session sofort durch. Ohne Repository verhält sie sich wie bisher.
- Neue Methode `SessionRegistry.restore()`: lädt die gespeicherten Sessions und gleicht sie nach ADR 0005 mit den Backends ab (WSL lebend → wieder angebunden und `Detached`, WSL fehlend → `Interrupted`, Windows → `Interrupted`, WSL nicht erreichbar → `Interrupted` und `backend_unavailable` im Ergebnis).
- `engines.node` steigt von `>=22.5` auf `>=22.13`, weil `node:sqlite` erst ab 22.13 ohne `--experimental-sqlite` nutzbar ist. Die CI nutzt Node `22` (aktuelle 22.x) und bleibt unverändert.
- ADR 0004 wird um die Spalten ergänzt, die für ein vollständiges Wiederherstellen nötig sind (`shell`, `env`, `cols`, `rows`), und die Node-Mindestversion präzisiert.
- Keine Breaking Changes: Bestehende Registry-Signaturen bleiben, es kommen nur optionale Optionen und eine neue Methode hinzu.

## Capabilities

### New Capabilities

- `session-persistence`: Ablage der Session-Metadaten, Schema-Migrationen und Reconcile der gespeicherten Sessions beim Core-Start.

### Modified Capabilities

(keine; die Übergänge und das Verhalten laufender Sessions aus `session-lifecycle` bleiben unverändert)

## Impact

- Paket `packages/core`: neues Modul `src/storage/` (Datenverzeichnis, Datenbank, Migrationen, Repositories), Erweiterung von `src/session/registry.ts` (Option `repository`, Methode `restore`), Exporte in `src/index.ts` unter `// storage`.
- `packages/protocol`, `packages/core/src/backend/types.ts` und `src/backend/fake.ts` bleiben unverändert.
- IPC-Methoden: keine neuen. `backend_unavailable` aus dem Reconcile-Ergebnis meldet der Core später über die Statusleiste.
- Datenmodell: neue SQLite-Tabellen; `SessionInfo` bleibt unverändert. `writerViewId` und Views werden nicht gespeichert, weil nach einem Core-Neustart keine View angehängt ist.
- Dependencies: keine neuen (`node:sqlite` ist in Node eingebaut).
- Non-Goals: kein Verlauf-Ringpuffer, keine Profile, kein Autostart (Phase 3), keine Repositories für Workspaces, Projekte und Layouts (nur die Tabellen; die Logik kommt mit den Workspace- und Layout-Issues), kein Löschen von Sessions.
- Security: Die Datenbank liegt im Benutzerprofil (`%APPDATA%`). `LaunchSpec.env` wird mitgespeichert; laut `model.ts` und Security-Regeln gehören dort keine Secrets hinein. Terminal-Ausgabe wird nicht gespeichert.
