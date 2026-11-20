# Tasks

## 1. Reine Funktionen

- [x] 1.1 Test und Umsetzung: `describeError` (Error, String, einfaches Objekt, `DOMException`-artiges Objekt, nie `[object Object]`) (`main/screenshot.test.ts`)
- [x] 1.2 Test und Umsetzung: `runGroupsWithRetry` (grün ohne Wiederholung, einmal wiederholt und weiter mit den folgenden Gruppen, zweiter Fehler wirft, Fehler ohne Gruppe wirft ohne Wiederholung, Meldung `retry <gruppe>: <fehler>`, Liste der Wiederholungen) (`main/screenshot.test.ts`)

## 2. Szenen

- [x] 2.1 Warten auf Endzustände in den Split-Szenen (vim-Lineal, Cursor-Vergleich mit neu gelesenem tmux, neue `stty`-Antwort) (`main/screenshot-scenario.ts`, geprüft durch volle Screenshot-Läufe)
- [x] 2.2 Zwischenablage der Tastenkürzel-Szene mit Fokus und Wiederholung, lesbarer Fehler (`main/screenshot-scenario.ts`, geprüft durch volle Screenshot-Läufe)
- [x] 2.3 Verdrahtung: `runScenario` meldet die Gruppe des Fehlers, `main.ts` setzt zurück, wiederholt und fasst Wiederholungen zusammen (geprüft durch volle Screenshot-Läufe und 1.2)

## 3. Doku

- [x] 3.1 Eintrag in `docs/agent-lessons-learned.md`, Abschnitt Screenshots
