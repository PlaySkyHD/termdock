# Tasks

## 1. Monitorwahl

- [x] 1.1 Test und Umsetzung: `screenshotOrigin` liefert den ersten Nebenmonitor, die gewählte Nummer, `primary` und bei nur einem Monitor den Hauptmonitor (`window-geometry.test.ts`)
- [x] 1.2 `main.ts` öffnet Screenshot-Fenster ohne gespeicherte Position dort; `screenshot-restore.ts` positioniert relativ zum ersten Fenster (Lauf `--scenes restore` endet mit Code 0, Fenster auf dem Nebenmonitor)

## 2. Doku

- [x] 2.1 `docs/agent-lessons-learned.md` nennt `TERMDOCK_SCREENSHOT_DISPLAY` (Prüfung: `npm run format:check`)
