# Tasks

## 1. Schlange

- [x] 1.1 Test und Umsetzung: `CloseQueue` startet einen Schritt erst nach dem vorigen, ein Fehler hält die Folgenden nicht auf, `idle` wartet auch auf später eingereihte Schritte und gibt nach seinem Zeitlimit auf (`backend/wsl/close-queue.test.ts`)
- [x] 1.2 Test und Umsetzung: Abbau einer Registry mit 20 `cmd.exe`-PTYs über `spawnConpty` und `WslPty`, fünf Runden: direkt danach läuft jeder Prozess, nach `ptysClosed()` keiner mehr, in unter 15 s (`backend/wsl/pty-shutdown.test.ts`, „closes 20 PTYs“); ohne Schlange rot
- [x] 1.3 Test und Umsetzung: PTY vor ihrer ersten Ausgabe endet in unter 5 s (`backend/wsl/pty-shutdown.test.ts`, „ends a PTY closed before its first output“)
- [x] 1.4 Test und Umsetzung: Absturz des Lesers nutzt dieselbe Schlange, jede PTY endet genau einmal (`backend/wsl/conout-reader.test.ts`, „closes every PTY once when the worker crashes“)
- [x] 1.5 Test und Umsetzung: `WslBackend.dispose` endet erst nach `ptysClosed` (`backend/wsl/backend.test.ts`, „dispose resolves only once the closes of the PTYs are done“)

## 2. Shutdown mit Stop

- [x] 2.1 Test und Umsetzung: `killAll` schließt jede PTY und wartet auf `closed()`, bevor das Backend die Session beendet; ein scheiterndes Backend lässt die Session `Interrupted` (`session/registry.test.ts`, „killAll (issue #160)“)
- [x] 2.2 Test und Umsetzung: mit zehn `cmd.exe`-PTYs läuft kein Prozess mehr, wenn das Backend seine Session beendet (`backend/wsl/pty-shutdown.test.ts`, „killAll closes each PTY“)
- [x] 2.3 `core.shutdown { stopSessions }` nutzt `killAll`; geprüft durch die bestehenden Shutdown-Tests in `ipc/ipc.test.ts` und `e2e.wsl.test.ts`

## 3. Skripte, Dokumentation und Messung

- [x] 3.1 `scripts/pty-shutdown-repro.mjs` mit Tests der Argumente (`scripts/pty-shutdown-repro.test.mjs`); 50 Läufe mit 20 PTYs unter Node und Electron ohne Absturz, geprüft durch den Exit-Code des Skripts
- [x] 3.2 Lasttest zeigt die Dauer des Shutdowns (`scripts/load-test.test.mjs`, „evaluate shows how long the core shutdown took“); je drei Läufe unter Node und Electron, Werte im PR
- [x] 3.3 Nachtrag in ADR 0008; geprüft durch `npm run format:check` und den Review
