# Tasks

## 1. Brücke

- [x] 1.1 Test und Umsetzung: zehn neue Aufrufe mit Laufzeitprüfung und Weitergabe an `workspace.*`, `project.*`, `session.update|archive|delete`; ungültige Aufrufe ohne Core-Anfrage (`main/bridge.test.ts`, `shared/bridge.ts`, `main/bridge.ts`, `preload/preload.cts`)
- [x] 1.2 Test und Umsetzung: `workspaceChanged`, `sessionUpdated`, `sessionRemoved` an alle Fenster, `sessionRemoved` vergisst die Sequenznummer (`main/bridge.test.ts`)

## 2. Store und Synchronisation

- [x] 2.1 Test und Umsetzung: `setWorkspaces`, `sessionUpdated` (Zustand bleibt, unbekannte Session wird ergänzt), `sessionRemoved` (`renderer/ui-store.test.ts`, `ui-store.ts`)
- [x] 2.2 Test und Umsetzung: `connectStore` hört die drei Events, hält sie vor der Liste zurück, lädt Workspaces, übersteht ein scheiterndes `listWorkspaces` (`renderer/session-sync.test.ts`, `session-sync.ts`)
- [x] 2.3 Test: Der Tab einer gelöschten Session behält sein Pane, das den Platzhalter „Session nicht gefunden“ zeigt (`renderer/ui-store.test.ts`, `renderer/pane-placeholder.test.ts`)

## 3. Sidebar-Modell

- [x] 3.1 Test und Umsetzung: Abschnitte (Workspaces in Core-Reihenfolge, „Ohne Gruppe“ mit unbekanntem Workspace, Archiv), Zielregeln, Menüeinträge, Bestätigungstexte (`renderer/sidebar-model.test.ts`, `sidebar-model.ts`, `session-display.ts`)

## 4. Drag&Drop

- [x] 4.1 Test und Umsetzung: Zustandsmaschine (Schwelle, gültige Ziele, Ziel unter dem Zeiger, Drop, Esc, Loslassen auf ungültigem Ziel) (`renderer/drag/drag-model.test.ts`, `drag-model.ts`)
- [x] 4.2 Test und Umsetzung: Controller mit gespeisten Fensterereignissen (Esc, `pointercancel`, `blur`, unterdrückter Klick, Aufräumen der Listener) (`renderer/drag/drag-controller.test.ts`, `drag-controller.ts`)

## 5. Oberfläche

- [x] 5.1 Test und Umsetzung: Navigation im Kontextmenü (`renderer/menu-navigation.test.ts`); Sidebar, Dialoge und Menü selbst prüft die Szene aus 6.1 (`Sidebar.tsx`, `Dialogs.tsx`, `ContextMenu.tsx`)
- [x] 5.2 Umsetzung: Verdrahtung in `App.tsx` (Aufrufe, Fehler in der Statusleiste, modale Dialoge sperren Tastenkürzel), geprüft durch die Szene aus 6.1

## 6. Screenshots

- [x] 6.1 Szenen der Sidebar mit Drag&Drop über `sendInputEvent`, Prüfung der Änderungen im Core (`main/screenshot-sidebar.ts`, Lauf von `npm run screenshot -w apps/desktop`)

## 7. Dokumentation

- [x] 7.1 ADR 0006: Brücke, Drag&Drop-Modul, Sidebar
