# Tasks

## 1. Regeln der Züge

- [x] 1.1 Baumfunktionen aus `ui-store.ts` nach `pane-tree.ts`; bestehende Store-Tests bleiben grün (`renderer/ui-store.test.ts`)
- [x] 1.2 Test und Umsetzung: `applyMove` für Umsortieren, Teilen über jede Zone, Ersetzen, Herausziehen, 4-Pane- und Tab-Grenze, leerer Tab schließt, aktiver Tab und aktives Pane, verbotene Züge (`renderer/layout-moves.test.ts`, `layout-moves.ts`)
- [x] 1.3 Test und Umsetzung: `UiStore.move` und `canMove`; das Ergebnis besteht `validateLayoutDocument`, wird gemeldet und nach `loadWindow` wiederhergestellt (`renderer/ui-store.test.ts`, `renderer/layout-sync.test.ts`)

## 2. Drag-Technik

- [x] 2.1 Test und Umsetzung: Zonen aus der Zeigerposition (Kanten, Mitte, Diagonalen, Rückfall auf die Mitte, Hälften eines Tabs) und Auflösung der Ziel-IDs (`renderer/drag/drop-zones.test.ts`, `drop-zones.ts`)
- [x] 2.2 Test und Umsetzung: Ziel-IDs von Tab-Leiste und Panes als Züge (`renderer/layout-drop.test.ts`, `layout-drop.ts`)
- [x] 2.3 Umsetzung: `DragProvider` je Fenster mit `useDropHandler` und Zonen-Zielen; die Sidebar registriert ihre Regeln; geprüft durch die Szenen aus 5.1 und die bestehende Sidebar-Szene

## 3. Tastatur und Menüs

- [x] 3.1 Test und Umsetzung: Kürzel `moveTabLeft`/`moveTabRight` (`Ctrl+Shift+PageUp`/`PageDown`) und Befehle (`renderer/keymap.test.ts`, `renderer/commands.test.ts`)
- [x] 3.2 Test und Umsetzung: Menüeinträge für Tab, Pane und Session mit gesperrten Zügen (`renderer/layout-menus.test.ts`, `layout-menus.ts`, `renderer/sidebar-model.test.ts`)

## 4. Oberfläche

- [x] 4.1 Test und Umsetzung: flache Liste der Panes aller Tabs mit `data-tab-id`, `data-tab-active` (`renderer/pane-layout.test.ts`); Tab-Leiste und Panes als Quellen und Ziele, Überlagerung, Griff, Menüs (`App.tsx`, `TabBar.tsx`, `PaneTree.tsx`, `styles.css`), geprüft durch die Szenen aus 5.1

## 5. Screenshots

- [x] 5.1 Szenen mit `sendInputEvent`: Zonen, Ablegen in einen Split, umsortierte Tabs, herausgezogenes Pane, Esc; Prüfung der Views über die Brücke (`main/screenshot-tabs.ts`); Selektoren der bestehenden Szenen auf `data-tab-active`

## 6. Dokumentation

- [x] 6.1 ADR 0006: flache Pane-Liste, `layout-moves.ts`, erweiterte Drag-Technik
