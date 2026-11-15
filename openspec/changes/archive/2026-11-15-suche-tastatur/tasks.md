# Tasks

## 1. Auswahl-Logik

- [x] 1.1 Test und Umsetzung: `moveSelection` (Anfang je Richtung, Schritte, Stehenbleiben an den Enden, Pos1/Ende, leere Liste) und `hitAt` über Gruppen (`renderer/history-search.test.ts`, `history-search.ts`)
- [x] 1.2 Test und Umsetzung: `HistorySearchModel.move` und `activate` (Auswahl über Gruppen, Pos1/Ende erst mit Auswahl, Enter öffnet oder sucht, veralteter Text, Zurücksetzen bei neuem Ergebnis) (`renderer/history-search.test.ts`)

## 2. Oberfläche

- [x] 2.1 `SearchDialog.tsx`: Tasten im Suchfeld, `combobox`/`listbox`/`option`, `aria-activedescendant`, Hervorhebung und Scrollen; Stil `search__hit--selected` (geprüft durch die Szene in 3.1)

## 3. Screenshot-Szene

- [x] 3.1 `screenshot-search.ts`: Pfeiltasten und Enter über `sendInputEvent`, Prüfung von Fokus, Auswahl und aktivem Tab, zwei PNG (Lauf `npm run screenshot -w apps/desktop`, Exit-Code 0)
