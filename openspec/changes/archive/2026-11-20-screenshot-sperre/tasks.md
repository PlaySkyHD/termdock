# Tasks

## 1. Reine Funktionen

- [x] 1.1 Test und Umsetzung: `screenshotLockState` (keine Datei frei, lebender Halter belegt, toter Halter frei, eigene PID frei, unlesbarer Inhalt erst nach 5 s frei, Sperre älter als 12 min frei) (`main/screenshot.test.ts`)
- [x] 1.2 Test und Umsetzung: `tryScreenshotLock` (legt an mit eigener PID, meldet lebenden Halter ohne Änderung, ersetzt verwaiste Sperre) (`main/screenshot.test.ts`)
- [x] 1.3 Test und Umsetzung: `acquireScreenshotLock` (wartet bis zur Freigabe, loggt `waiting for screenshot run <pid>` einmal je Halter, gibt nach 15 min auf und lässt die fremde Sperre liegen) (`main/screenshot.test.ts`)
- [x] 1.4 Test und Umsetzung: `releaseScreenshotLock` (entfernt nur die eigene Sperre) und `nodeLockFs` gegen ein echtes Temp-Verzeichnis (`main/screenshot.test.ts`)

## 2. Verdrahtung

- [x] 2.1 `main.ts`: Sperre vor `connectOrStartCore`, Aufgeben mit Code 1, Freigabe in `finish()` und beim gescheiterten Verbinden (geprüft durch einen Lauf `--scenes scenario` und zwei gleichzeitig gestartete Läufe `--scenes sidebar`, deren zweiter wartet)

## 3. Doku

- [x] 3.1 Eintrag in `docs/agent-lessons-learned.md`, Abschnitt Screenshots (geprüft durch Review)
