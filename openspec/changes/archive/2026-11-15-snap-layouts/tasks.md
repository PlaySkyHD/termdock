# Tasks

## 1. Regeln

- [x] 1.1 Test und Umsetzung: Muster, Felder, `applySnap` für jedes Muster aus 1 bis 4 Panes, Feldwahl, zusammengeführter Tab, 4-Pane-Grenze, gleiche Panes und Sessions, abgelehnte Züge, `snapFields`, `visiblePatterns`, `snapBarOpen` (`renderer/snap-layouts.test.ts`, `snap-layouts.ts`, Ziel `snap` in `layout-moves.ts`)
- [x] 1.2 Test und Umsetzung: `UiStore.move` mit Muster für 1 bis 4 Panes, 4-Pane-Grenze ohne Meldung, Rollen (schreibendes und lesendes Pane einer Session) bleiben, Wiederherstellung nach `loadWindow`; gemeldetes Layout (`renderer/ui-store.test.ts`, `renderer/layout-sync.test.ts`)
- [x] 1.3 Test und Umsetzung: Ziel-IDs `snap:<muster>:<feld>` (`renderer/layout-drop.test.ts`, `layout-drop.ts`)

## 2. Tastatur und Menüs

- [x] 2.1 Test und Umsetzung: Muster-Einträge in den Menüs von Tab und Pane mit Gründen für gesperrte Einträge (`renderer/layout-menus.test.ts`, `layout-menus.ts`)

## 3. Oberfläche

- [x] 3.1 Umsetzung: Muster-Leiste mit beschrifteten Feldern, immer eingehängt, offen am oberen Rand (`SnapBar.tsx`, `App.tsx`, `styles.css`), geprüft durch die Szenen aus 4.1

## 4. Screenshots

- [x] 4.1 Szenen mit `sendInputEvent`: Leiste mit Namen, Esc, Ablegen auf „2 nebeneinander“ und „1 + 2“, ausgeblendete Muster, Menüweg zu „2 × 2“ per Tastatur; Prüfung von Views, Rollen und Geometrie (`main/screenshot-snap.ts`)

## 5. Dokumentation

- [x] 5.1 ADR 0006: Layout-Vorschläge beim Ziehen
