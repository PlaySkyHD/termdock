# Tasks

## 1. Protokoll

- [x] 1.1 `core.status` in `packages/protocol` (Typ, Payload-Regeln, Guards); Test in `guards.test.ts`

## 2. Registry

- [x] 2.1 Optionale Backend-Methode `resolveLaunch` (`backend/types.ts`), `FakeBackend.defaultDistro`, Auflösen und Speichern in `launch`; Test in `session/registry.test.ts`
- [x] 2.2 Wiederanbinden nach PTY-Ende ohne Exit-Code (`exists` → `attach`, 3 Versuche, gemeinsames Budget), `FakePty.loseClient()`; bestehende Tests auf das asynchrone `Interrupted` anpassen; Test in `session/reattach.test.ts`
- [x] 2.3 `SessionRegistry.dispose()` und `backendUnavailable()`; Test in `session/reattach.test.ts` und `session/restore.test.ts`

## 3. Core

- [x] 3.1 `WslBackend.resolveLaunch`; Test in `backend/wsl/backend.test.ts`
- [x] 3.2 `CoreServer`-Option `ready` und Fall `core.status`
- [x] 3.3 `runCore`: Pipe → Storage → Backend → Restore → `ready`, `close()` mit Abbau, stderr-Meldung für `backend_unavailable`, Optionen `dataDir`, `tmuxSocket`; Test in `bin/run-core.test.ts`
- [x] 3.4 End-to-End-Test `e2e.wsl.test.ts` hinter `TERMDOCK_WSL_TESTS=1`; dabei gefunden: `EAGAIN` an der Eingabepipe von node-pty nach verlorenem Client beendete den Prozess, abgefangen in `spawnPty`; WSL-Testdateien laufen mit `TERMDOCK_WSL_TESTS=1` nacheinander (`vitest.config.ts`), weil sie sich den tmux-Socket teilen

## 4. Dokumentation und Abschluss

- [x] 4.1 ADR 0003 (Präzisierungen aus #4) und ADR 0001 (Startreihenfolge) ergänzen
- [x] 4.2 Exporte in `src/index.ts` unter `// assembly`
- [x] 4.3 Typecheck, Lint, Format, Tests (auch mit `TERMDOCK_WSL_TESTS=1`)
