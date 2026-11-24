# Tasks

## 1. Core-Vertrag

- [x] 1.1 Test: Übergabe `attach` → `claimWriter` → `detach` ergibt nie zwei Schreiber und keinen Moment ohne Schreiber, eine lesende View bleibt lesend (`packages/core/src/session/registry.test.ts`)

## 2. Renderer-Modell

- [x] 2.1 Test und Umsetzung: Zustandsmaschine mit `outside`, Effekt `outside` für Nutzlasten, die das Fenster verlassen dürfen (`renderer/drag/drag-model.test.ts`, `drag-model.ts`, `drag-controller.test.ts`, `drag-controller.ts`)
- [x] 2.2 Test und Umsetzung: `transferItem`, `applyIncoming`, `withoutIncoming`, `takeOut`, `settleIncoming` (`renderer/window-transfer.test.ts`, `window-transfer.ts`)
- [x] 2.3 Test und Umsetzung: `TerminalController` meldet das Ende des Anhängens (`renderer/terminal-controller.test.ts`)

## 3. Main

- [x] 3.1 Test und Umsetzung: `WindowTransfers` (Überfahren, Ablegen auf Fenster, außerhalb, auf das eigene, ganzes Fenster, Reihenfolge Anhängen → Schreibrecht → Lösen, Leser ohne `claimWriter`, Ablehnung, fehlender Nachfolger, Zeitlimit, geschlossene Fenster, Rücknahme übertragener Schreibrechte) (`main/window-transfer.test.ts`, `window-transfer.ts`)
- [x] 3.2 Test und Umsetzung: Brücke prüft die neuen Aufrufe, merkt sich Schreiber und leitet an `WindowTransfers` weiter (`main/bridge.test.ts`, `bridge.ts`, `shared/bridge.ts`, `preload.cts`)
- [x] 3.3 Umsetzung: Electron-Teil (`TransferHost` in `main.ts`, Fokus-Reihenfolge, Fenster an der Mausposition), geprüft durch die Szenen aus 5.1

## 4. Oberfläche

- [x] 4.1 Umsetzung: `DragProvider` mit äußerem Modus, `App.tsx` mit Quelle und Ziel der Übergabe, `PaneView` meldet Platzhalter, geprüft durch die Szenen aus 5.1

## 5. Screenshots

- [x] 5.1 Szenengruppe `drag` (`main/screenshot-drag.ts`): Zonen im Zielfenster, Ablegen, neues Fenster, Neustart der Oberfläche; Prüfung von Rolle und gelösten Views über die Brücke

## 6. Dokumentation

- [x] 6.1 ADR 0006, Lessons (Szenengruppe `drag`, Präfixe), AGENTS.md (Gruppenliste), `docs/acceptance.md` (V1-05)
