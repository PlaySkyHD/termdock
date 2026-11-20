# Tasks

## 1. Protokoll

- [x] 1.1 Test und Umsetzung: `session.restart { sessionId }` mit Ergebnis `{ session }`, `bad_request` bei fehlender oder leerer ID, unbekanntem Feld und Nutzdaten, Version `1.6` (`packages/protocol/src/guards-phase3.test.ts`, `guards.test.ts`)

## 2. Core

- [x] 2.1 Test und Umsetzung: Trennzeile als erste Ausgabe nach dem Neustart (View, Puffer, Reihenfolge vor der PTY-Ausgabe), zweiter paralleler `restart` mit `invalid_state` und genau einem Start (`packages/core/src/session/registry.test.ts`)
- [x] 2.2 Test und Umsetzung: `session.restart` über die Pipe: `Interrupted` → neue Session mit gleicher ID, `LaunchSpec` und Workspace, Events `Starting` und `Detached`; `invalid_state` bei `Running`/`Detached`; `not_found`; zwei parallele Anfragen mit genau einem Start (`packages/core/src/ipc/session-management.test.ts`)
- [x] 2.3 Test: Trennzeile im Verlauf über Recorder und `HistoryStore` (`packages/core/src/ipc/session-management.test.ts`)
- [x] 2.4 WSL-Integrationstest: `session.restart` einer `Interrupted`-Session ohne tmux-Session startet genau eine neue; ist unter ihrem Namen wieder eine tmux-Session da, bindet sich der Neustart an sie an (gleiche `pane_pid`, genau eine Session) (`packages/core/src/session-management.wsl.test.ts`, Socket aus `wslTestSocket()`)
- [x] 2.5 ADR 0002 (1.6) und ADR 0005 (Neustart über die IPC) ergänzt; geprüft durch `bash scripts/openspec-check.sh --specs` nach dem Archivieren

## 3. Desktop

- [x] 3.1 Test und Umsetzung: Bridge-Aufruf `restartSession` → `session.restart`, `bad_request` ohne oder mit leerer ID (`apps/desktop/src/main/bridge.test.ts`)
- [x] 3.2 Test und Umsetzung: `canRestart` und `restartable` im Platzhalter nur für `Exited`/`Interrupted` (`apps/desktop/src/renderer/pane-placeholder.test.ts`, `session-display.test.ts`)
- [x] 3.3 Test und Umsetzung: Eintrag „Neu starten“ im Sidebar-Menü nur für `Exited`/`Interrupted` (`apps/desktop/src/renderer/sidebar-model.test.ts`)
- [x] 3.4 Knopf im Platzhalter und Menüeintrag verdrahtet (`PaneTree.tsx`, `Sidebar.tsx`, `App.tsx`, Preload); geprüft durch die Screenshot-Szenen 19a und 19b (`npm run screenshot -w apps/desktop -- <dir> --scenes restore`)
- [x] 3.5 Szenen `19a-session-restarted.png` und `19b-sidebar-restart-menu.png` mit Sichtbarkeitsselektor in `screenshot-restore.ts`; die Prüfung „geschlossenes Pane gespeichert“ wartet auf das Layout statt einmal zu lesen und holt das Fenster nach vorn; geprüft durch `scene-prefixes.test.ts` und den Screenshot-Lauf
