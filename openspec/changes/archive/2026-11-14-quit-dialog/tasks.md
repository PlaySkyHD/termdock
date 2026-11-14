# Tasks

## 1. Core: Einstellungen

- [x] 1.1 Test und Umsetzung: `SettingsRepository` (SQLite und In-Memory): Standard, Zusammenführen, `null` entfernt, ungültiges Ergebnis `bad_request`, Neuöffnen, unbrauchbare Zeile (`storage/settings-repository.test.ts`, `settings-repository.ts`, `database.ts`)
- [x] 1.2 Test und Umsetzung: `settings.get`, `settings.set` und `settings.changed` über die Pipe (`ipc/ipc.test.ts`, `server.ts`, `run-core.ts`, `index.ts`)

## 2. Desktop: Entscheidung und Dialog

- [x] 2.1 Test und Umsetzung: `countActive`, `planQuit`, `outcomeOfAnswer` (keine laufende Session, gespeicherte Wahl, Abbrechen, `session-end`) (`shared/quit-decision.test.ts`, `quit-decision.ts`)
- [x] 2.2 Test und Umsetzung: `QuitPrompt` (eine offene Frage, Antwort nur vom gefragten Fenster, verschwundenes Fenster = Abbrechen) (`main/quit-prompt.test.ts`)
- [x] 2.3 Test und Umsetzung: Brücke nimmt `answerQuit` an und prüft Wahl und ID (`main/bridge.test.ts`, `bridge.ts`, `shared/bridge.ts`, `preload.cts`)
- [x] 2.4 Umsetzung: Dialog im Renderer und Ablauf im Main (`QuitDialog.tsx`, `App.tsx`, `main.ts`); belegt durch die Screenshot-Szene (2.5)
- [x] 2.5 Screenshot-Szene: Dialog ohne und mit „Nicht mehr fragen“, Abbrechen speichert nichts, gespeicherte Wahl fragt nicht mehr (`screenshot-scenario.ts`)

## 3. Dokumentation

- [x] 3.1 ADR 0006 nennt den Schließen-Dialog
