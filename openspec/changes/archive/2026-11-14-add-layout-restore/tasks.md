# Tasks

## 1. Abbildung und Platzhalter (rein)

- [x] 1.1 Test und Umsetzung: Abbildung Store ↔ `LayoutDocument` in beide Richtungen (`shared/layout-mapping.ts`)
- [x] 1.2 Test und Umsetzung: Bildschirm-Prüfung der Geometrie (`main/window-geometry.ts`)
- [x] 1.3 Test und Umsetzung: Platzhalter je Pane (`renderer/pane-placeholder.ts`)
- [x] 1.4 Test und Umsetzung: Store `loadWindow`, `sessionsLoaded` (`renderer/ui-store.ts`)

## 2. Speichern im Main

- [x] 2.1 Test und Umsetzung: `LayoutCoordinator` (Bündeln, Flush, Revisionskonflikt mit erneutem Speichern, Prüfung der Meldungen, Fenster schließen)
- [x] 2.2 Test und Umsetzung: Brücken-Aufrufe `windowLayout` und `reportLayout` mit Prüfung (`main/bridge.ts`, `shared/bridge.ts`, Preload)

## 3. Oberfläche

- [x] 3.1 Test und Umsetzung: Synchronisation des Stores mit dem Main (`renderer/layout-sync.ts`)
- [x] 3.2 Platzhalter in `PaneTree.tsx` mit „Pane schließen“, `App.tsx` startet die Synchronisation
- [x] 3.3 `main.ts`: Layout laden, Fenster mit geprüfter Geometrie öffnen, Geometrie melden, Flush beim Beenden

## 4. Screenshots und Dokumentation

- [x] 4.1 Screenshot-Szenen: 2 Fenster mit Tabs und Splits vor und nach dem Neustart der Oberfläche, Platzhalter `Interrupted` und `Exited`
- [x] 4.2 ADR 0006 ergänzen
