# Tasks

## 1. Protokoll

- [x] 1.1 `SessionInfo.currentCwd`, Event `session.cwdChanged`, `isValidCurrentCwd`, Version 1.8 (`packages/protocol/src/guards.test.ts`, „accepts a current directory in session.cwdChanged …“, „rejects a malformed current directory …“, „exports the rule for a current directory …“, „speaks protocol 1.8 …“)

## 2. Backend

- [x] 2.1 Optionale Methode `Backend.currentCwd`; `FakeBackend` mit Option `currentCwd`, `setCwd`, `cwdGate` (genutzt in `session/registry-cwd.test.ts`)
- [x] 2.2 Argumente und Parser der tmux-Abfrage (`backend/wsl/commands.test.ts`, „builds the current-directory query …“, „parses the current directory and drops what a client would reject“)
- [x] 2.3 `WslBackend.currentCwd` mit `--cd ~` und 5 s, `undefined` bei Fehler, Zeitüberschreitung, fehlender Session und ungültiger ID (`backend/wsl/backend.test.ts`, „currentCwd asks tmux once …“, „currentCwd gives undefined …“)

## 3. Registry und Core

- [x] 3.1 `CwdProbe`: Pause, Mindestabstand, eine Abfrage zur Zeit, `poke` vor Dauerausgabe, `idle`, Abbau (`session/cwd-probe.test.ts`)
- [x] 3.2 Registry fragt nur mit View und PTY, meldet nur Änderungen, entfernt das Verzeichnis beim Ende, verwirft späte Ergebnisse, fragt nach Wiederanbinden neu, baut bei `dispose` ab (`session/registry-cwd.test.ts`)
- [x] 3.3 Repository speichert `currentCwd` nicht (`session/registry-cwd.test.ts`, „does not store the directory (runtime state)“)
- [x] 3.4 `session.cwdChanged` an Views und Listenclients, `session.list` mit `currentCwd`, Version 1.8 im Handshake (`ipc/ipc.test.ts`, „sends session.cwdChanged to the owner of a view and to listers …“, „accepts clients with protocol 1.2 to 1.7 and answers 1.8 …“)
- [x] 3.5 WSL-Integrationstest: nach `cd /tmp` meldet der Core `/tmp` innerhalb von 15 s (`cwd.wsl.test.ts`, `TERMDOCK_WSL_TESTS=1`)

## 4. Desktop

- [x] 4.1 Brücken-Event `cwdChanged` an alle Fenster (`main/bridge.test.ts`, „forwards the current directory of a session to every window …“)
- [x] 4.2 `withCurrentCwd`, `currentCwdOf`, `UiStore.sessionCwdChanged`, Entfernen beim Ende (`renderer/session-cwd.test.ts`)
- [x] 4.3 `session-sync.ts` wendet `cwdChanged` an und hält es vor der ersten Liste in Reihenfolge mit `stateChanged` (`renderer/session-sync.test.ts`, „applies cwdChanged …“, „takes the directory from the list“)

## 5. Dokumentation

- [x] 5.1 ADR 0002 (Version 1.8, Event), ADR 0003 (Backend-Methode, Abfrage); geprüft durch `bash scripts/openspec-check.sh --specs`
