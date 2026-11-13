# Tasks

## 1. Protokoll

- [x] 1.1 Typen in `model.ts`, Prüfung `validateLayoutDocument` in `guards.ts` (test-first: gültig, mehr als 4 Panes, doppelte IDs, falsche `sizes`, unbekannte aktive IDs)
- [x] 1.2 Methoden `layout.get` und `layout.save` in `messages.ts` und `guards.ts` (Parameter, Ergebnis, Nutzdatenregeln)

## 2. Core

- [x] 2.1 Migration 2 (`revision`) und `LayoutRepository` (SQLite und In-Memory), Tests in `storage/layout-repository.test.ts`
- [x] 2.2 Verdrahtung in `ipc/server.ts` und `bin/run-core.ts`, Exporte in `index.ts`; IPC-Test (`save` → `get`, Revisionskonflikt, Neustart des Core)

## 3. Abschluss

- [x] 3.1 ADR 0002 (Methodenliste) und ADR 0004 (Tabelle `layouts`, Revision) nachziehen
- [x] 3.2 Typecheck, Lint, Format, Tests von `packages/protocol` und `packages/core` grün
