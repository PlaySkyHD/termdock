# Tasks

## 1. Protokoll

- [x] 1.1 Test und Umsetzung: Typen und Grenzen der Phase 3, `DEFAULT_SETTINGS`, Version `1.3` (`guards.test.ts`, `guards-phase3.test.ts`, `model.ts`)
- [x] 1.2 Test und Umsetzung: Guards für `workspace.*` und `project.*` – gültig, ungültig, Grenzen, unbekannte Felder (`guards-phase3.test.ts`, `messages.ts`, `guards.ts`)
- [x] 1.3 Test und Umsetzung: Guards für `profile.*` inklusive Profilgröße (`guards-phase3.test.ts`, `messages.ts`, `guards.ts`)
- [x] 1.4 Test und Umsetzung: Guards für `session.update|archive|delete` und `session.create` aus Profil (`guards-phase3.test.ts`, `messages.ts`, `guards.ts`)
- [x] 1.5 Test und Umsetzung: Guards für `settings.get|set` und `history.search` (`guards-phase3.test.ts`, `messages.ts`, `guards.ts`)
- [x] 1.6 Test und Umsetzung: Events `session.updated`, `session.removed`, `workspace.changed`, `profile.changed`, `settings.changed` (`guards-phase3.test.ts`, `messages.ts`, `guards.ts`)

## 2. Core

- [x] 2.1 Test und Umsetzung: Migration 3, Migration 2 → 3 behält Bestandsdaten, Profil verliert die Bindung (`database.test.ts`, `migrations.ts`)
- [x] 2.2 Test und Umsetzung: Stub je neuer Methode und für `session.create` ohne `launch`, Verbindung bleibt offen (`ipc.test.ts`, `server.ts`)
- [x] 2.3 Test und Umsetzung: `notifyListers` sendet Phase-3-Events nur an Listen-Clients (`ipc.test.ts`, `server.ts`)
- [x] 2.4 Test: Handshake antwortet mit `1.3` und akzeptiert `1.2` (`ipc.test.ts`)

## 3. Dokumentation

- [x] 3.1 ADR 0002: Methoden, Events und Version 1.3; ADR 0004: Tabellen der Phase 3
