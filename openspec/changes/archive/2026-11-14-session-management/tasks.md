# Tasks

## 1. Speicher

- [x] 1.1 Test und Umsetzung: `SessionRepository.delete` für SQLite und In-Memory, unbekannte ID ist kein Fehler (`session-repository.test.ts`, `session-repository.ts`, `run-core.ts`)
- [x] 1.2 Test und Umsetzung: Verlauf entfernen über `HistoryStore.remove` aus #59 (ID-Prüfung und Idempotenz in `history-store.test.ts`; Verdrahtung in `run-core.ts`, echter Verlauf in `ipc/session-management.test.ts`)

## 2. Registry

- [x] 2.1 Test und Umsetzung: `update` – umbenennen ohne Prozesswechsel, gruppenlos und zurück, Verlauf-Schalter, Archiv umbenennen, ungültiger Name, unbekannte Session, gespeichert (`session-management.test.ts`, `registry.ts`)
- [x] 2.2 Test: Archivieren einer laufenden Session beendet den Prozess und entfernt den Verlauf nicht (`session-management.test.ts`)
- [x] 2.3 Test und Umsetzung: `delete` – abgelehnt in `Running`, `Detached`, `Starting`; `Exited` mit Views, Verlauf und Zeile; verbliebene Backend-Session bei `Interrupted`; `Archived` ohne Backend; Fehler bei Existenzprüfung, Beenden, Verlauf und Zeile lassen die Session; Sperre während des Löschens; `dispose` während des Löschens (`session-management.test.ts`, `registry.ts`)

## 3. IPC und Zusammenbau

- [x] 3.1 Test und Umsetzung: `session.update` mit `session.updated` an Listen-Clients, `not_found` für unbekannte Session und unbekannten Workspace (`ipc/session-management.test.ts`, `server.ts`)
- [x] 3.2 Test und Umsetzung: `session.archive` – Prozess beendet, `Archived` gemeldet, Verlauf bleibt, View vergessen (`ipc/session-management.test.ts`, `server.ts`)
- [x] 3.3 Test und Umsetzung: `session.delete` – laufend abgelehnt; Verlauf, Zeile und View weg, `session.removed`, neuer Core lädt sie nicht (`ipc/session-management.test.ts`, `server.ts`, `run-core.ts`)
- [x] 3.4 Test: Stub-Test prüft nur noch die offenen Methoden (`ipc.test.ts`)
- [x] 3.5 WSL-Test: Archivieren beendet die tmux-Session, Löschen einer `Interrupted`-Session beendet eine verbliebene tmux-Session und entfernt den Verlauf (`session-management.wsl.test.ts`)

## 4. Dokumentation

- [x] 4.1 ADR 0004 und ADR 0005: Löschen (Reihenfolge, Verlaufspfad) und `update` (Prüfung: Review des Diffs)
