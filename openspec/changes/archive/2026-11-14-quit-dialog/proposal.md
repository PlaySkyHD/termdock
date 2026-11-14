# Proposal

## Why

Beim Beenden der App (Menü, Strg+Q, letztes Fenster schließen) bleiben die Sessions bisher immer erhalten, und der Benutzer hat keine Wahl. Das Konzept (Kap. 2 und 6, Abnahme 13) verlangt einen Dialog, der nur bei laufenden Sessions fragt und sich mit „Nicht mehr fragen“ abschalten lässt (Issue #60). Damit die Wahl bleibt, braucht der Core die Einstellungen aus Protokoll 1.3: `settings.get` und `settings.set` sind bisher Platzhalter (Issue #55; ursprünglich dem Dialog der Einstellungen #64 zugeordnet, der nur noch die Oberfläche baut).

## What Changes

- **Core:** `SettingsRepository` (SQLite auf der Tabelle `settings`, In-Memory für Tests) mit synchronem `get(): Settings` und `set(patch): Settings`. `settings.get` und `settings.set` ersetzen ihre Platzhalter; `settings.set` führt den Patch zusammen, prüft das Ergebnis mit `validateSettings` und sendet `settings.changed` an alle Listen-Clients.
- **Desktop:** Beim Beenden durch den Benutzer fragt ein Dialog im Renderer, aber nur bei Sessions in `Running` oder `Detached`. Optionen: „Oberfläche schließen, Sessions behalten“, „Sessions beenden“ (`core.shutdown { stopSessions: true }` nach dem Speichern des Layouts), „Abbrechen“. „Nicht mehr fragen“ speichert `confirmQuitWhileRunning: false` und die Aktion in `quitAction`. `session-end` fragt nie und behält die Sessions.
- Die Entscheidungslogik ist eine reine Funktion (`planQuit`, `outcomeOfAnswer`) mit Tests.
- Neue Brücken-Aufrufe: Event `quitRequested` (Main an Renderer) und Aufruf `answerQuit` (Renderer an Main).
- Screenshot-Szene des Dialogs (ohne und mit gesetzter Checkbox).

## Capabilities

### New Capabilities

- `settings`: Speichern, Lesen, Zusammenführen und Melden der globalen Einstellungen im Core.

### Modified Capabilities

- `desktop-shell`: „Schmale Brücke zwischen Renderer und Main“ (Aufruf `answerQuit`); neue Anforderungen „Schließen-Dialog bei laufenden Sessions“ und „Screenshot-Szene des Schließen-Dialogs“.
- `core-ipc`: „Platzhalter für Methoden der Phase 3“ ohne `settings.*`.

## Impact

- `packages/core` (`storage/settings-repository.ts`, `storage/database.ts`, `bin/run-core.ts`, `ipc/server.ts`, `index.ts`), `apps/desktop` (`shared/quit-decision.ts`, `shared/bridge.ts`, `main/quit-prompt.ts`, `main/bridge.ts`, `main/main.ts`, `main/screenshot-scenario.ts`, `renderer/QuitDialog.tsx`, `renderer/App.tsx`, `preload`). ADR 0006 nennt den Dialog.
- Dependencies: keine neuen. Non-Goals: der Einstellungsdialog (#64), die Verdrahtung von `historyLimitBytes` und `historyEnabledByDefault` in den Verlauf (#59), Menü oder Tray.
- Security: `answerQuit` prüft Wahl und ID; nur das gefragte Fenster darf die offene Frage beantworten. Die Einstellungen enthalten keine Geheimnisse und laufen nur über die lokale Pipe (ADR 0002).
