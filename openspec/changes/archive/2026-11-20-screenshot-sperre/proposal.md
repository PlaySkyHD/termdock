# Proposal

## Why

In der Runde PRs #138, #139 und #143 liefen drei bis vier Agents gleichzeitig Screenshot-Läufe, zeitweise mit 12–27 Electron-Prozessen (#144). Die Läufe scheiterten in Szenen, die der jeweilige Diff nicht berührte (`UnknownVizError`, „no stty answer“); ein Lauf allein war jeweils grün. Jeder Lauf hat zwar eigenen Core, Socket und eigenes Profil, konkurriert aber um GPU und Fokus (`win.focus()`). Nichts serialisiert die Läufe auf dem Rechner, und die Wiederholung aus #127 verdeckt die Ursache nur.

## What Changes

- **Rechnerweite Sperre:** Der Screenshot-Modus legt vor dem Start des isolierten Cores die Datei `%TEMP%/termdock-screenshot.lock` exklusiv an (`fs.openSync(path, "wx")`) und schreibt seine PID hinein.
- **Warten:** Ist die Sperre belegt und lebt ihr Prozess, wartet der Lauf und loggt `waiting for screenshot run <pid>`. Nach höchstens 15 min endet er mit Code 1, ohne einen Core gestartet zu haben.
- **Verwaiste Sperren** (Prozess beendet, Inhalt unlesbar und älter als 5 s, oder älter als 12 min) gelten als frei und werden ersetzt.
- **Freigabe** in `finish()` und wenn das Verbinden mit dem isolierten Core scheitert; entfernt wird nur die eigene Sperre.
- Die Wartezeit zählt nicht in `SCREENSHOT_TIMEOUT_MS` (480 s): Der Wächter startet erst nach dem Core.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: neue Anforderung „Screenshot-Läufe laufen rechnerweit nacheinander“ (ADDED).

## Impact

- `apps/desktop/src/main/screenshot.ts` (reine Funktionen `screenshotLockState`, `tryScreenshotLock`, `acquireScreenshotLock`, `releaseScreenshotLock`, Dateisystem `nodeLockFs`), `main.ts`; Tests in `screenshot.test.ts`; `docs/agent-lessons-learned.md`.
