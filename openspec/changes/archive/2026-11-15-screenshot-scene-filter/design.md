# Design

## Kontext

`runScenario` spielte alle Szenen nacheinander ab. Spätere Szenen setzten Sessions früherer voraus: `sidebar` die Sessions Build, Done, Lost und Notes samt Zuständen, `restore` zusätzlich Editor, Shell und Misc aus den Split-Szenen und eine Done im Zustand `Exited`, `quit` mindestens eine laufende Session.

## Entscheidungen

### Feste Liste und Parser ohne Electron

`SCENE_GROUPS` und `screenshotScenes(argv)` stehen in `screenshot.ts` (ohne Electron, unit-getestet). Das Ergebnis folgt immer der Reihenfolge der Liste, unabhängig von der Eingabe, und enthält jede Gruppe einmal. `main.ts` prüft die Option vor dem Start des isolierten Cores; bei einem Fehler endet die App mit Code 1, ohne Temp-Verzeichnis oder Core.

### Gemeinsamer Aufbau statt Kopien

Der erste Abschnitt von `runScenario` (fünf Sessions in allen Zuständen, vier Tabs) läuft für `scenario`, `sidebar`, `restore` und `quit`; die Aufnahmen 01 bis 05, Split- und Tastenszenen nur für `scenario`. `restore` legt Editor, Shell und Misc selbst an, wenn sie fehlen, und wartet auf neun statt zehn Sessions im Fenster (fünf, drei und Crash). Die übrigen Gruppen legen ihre Sessions seit jeher selbst an.

## Risiken

- Ein einzelner Lauf zeigt nicht, ob Szenen sich gegenseitig stören; deshalb bleibt vor dem PR ein voller Lauf Pflicht (`AGENTS.md`).
