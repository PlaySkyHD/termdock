# Tasks

## 1. Storage

- [x] 1.1 `resolveDataDir` und `openStorage` in `packages/core/src/storage/database.ts`; Test in `storage/database.test.ts` (`TERMDOCK_DATA_DIR`, `%APPDATA%\TermDock`)
- [x] 1.2 `openDatabase` mit WAL und Migrationen (`storage/migrations.ts`: `schema_version`, Migration 1 mit `sessions`, `workspaces`, `projects`, `layouts`); Test: Migration auf leerer Datei, erneutes Öffnen, zu neues Schema
- [x] 1.3 `SessionRepository` mit `SqliteSessionRepository` und `InMemorySessionRepository`; Test in `storage/session-repository.test.ts` (Roundtrip mit und ohne optionale Felder, Upsert, kein Schreiber) für beide Implementierungen

## 2. Registry

- [x] 2.1 Option `repository` in `SessionRegistryOptions`, Durchschreiben bei Anlegen, Zustandswechsel (vor der Meldung), Exit-Code, Schreiberwechsel und Resize; Test in `session/restore.test.ts`
- [x] 2.2 `SessionRegistry.restore()` mit allen Reconcile-Fällen aus ADR 0005 (lebend, fehlend, Windows, nicht verfügbar, `exists` wirft, Backend fehlt, `attach` scheitert, beendete Sessions); Test in `session/restore.test.ts`
- [x] 2.3 Neustart-Test (Abnahme 09) mit zwei Registries auf derselben SQLite-Datei; Test in `session/restore.test.ts`

## 3. Integration

- [x] 3.1 Exporte in `packages/core/src/index.ts` unter `// storage`; ADR 0004 ergänzen (Spalten, Node ≥ 22.13), `engines.node` und README auf 22.13
- [x] 3.2 `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test -w packages/core` grün (Node 25.2.1 lokal und Node 22.23.5)
