# Tasks

## 1. Gemeinsamer ConPTY-Code

- [x] 1.1 `close-queue.ts`, `conout-reader.ts`, `pty.ts` (`ConptyPty`) und `spawnConpty` nach `backend/conpty/`; geprüft durch die verschobenen Tests (`backend/conpty/*.test.ts`), `security/argument-arrays.test.ts` und `TERMDOCK_WSL_TESTS=1 npm test -w packages/core`
- [x] 1.2 `ConptyPty` reicht das Ende an `resolveEnd`, `endReported()` meldet die Weitergabe (`backend/conpty/pty.test.ts`, „passes the exit of the process to the backend“, „endReported settles on dispose“)
- [x] 1.3 Verlust trägt `lost`, ein laufendes Schließen meldet allein (`backend/conpty/conout-reader.test.ts`, „closes every PTY once when the worker crashes“, „ends only the PTY whose relay connection fails“); vorher gelegentlich rot
- [x] 1.4 `scripts/pty-shutdown-repro.mjs` lädt die neuen Pfade und ältere Builds; geprüft durch `npm run test:hooks` und einen Lauf mit `--runs 5`

## 2. Windows-Backend

- [x] 2.1 Shell-Suche, Standardshell, Programm, Verzeichnis, Umgebung als reine Funktionen (`backend/windows/shells.test.ts`)
- [x] 2.2 Start mit `cmd.exe`, Ein- und Ausgabe, Verzeichnis (`backend/windows/backend.test.ts`, „[V1-15] starts cmd.exe in the working directory …“)
- [x] 2.3 Eingabe-Lock und Resize (`backend.test.ts`, „[V1-15] lets only the writer type and resize …“)
- [x] 2.4 Exit-Code, Kill, Neustart mit Trennzeile, keine zweite Shell (`backend.test.ts`, „[V1-15] ends Exited …“, „[V1-15] kill ends the shell …“, „[V1-15] restart starts a new shell …“)
- [x] 2.5 Snapshot aus dem Rohpuffer (`backend.test.ts`, „[V1-15] shows a late view the output so far …“)
- [x] 2.6 Archivieren und Löschen (`backend.test.ts`, „[V1-15] archive and delete end the shell …“)
- [x] 2.7 Fehlendes Verzeichnis, `~`, Netzlaufwerk ohne Antwort (`backend.test.ts`, „[V1-15] starts in the home directory …“, „starts ~ …“, „counts a directory check that does not answer as missing“)
- [x] 2.8 Umgebung ohne `ELECTRON_RUN_AS_NODE`, `launch.command` (`backend.test.ts`, „gives the shell launch.env …“, „runs launch.command as an argument array …“)
- [x] 2.9 Fehlende Shell mit Text, Standardshell gepinnt, Verlust → `Interrupted`, `kill` scheitert bei überlebender Shell, `exists`/`attach`, Abbau (`backend.test.ts`, „WindowsBackend without a real shell“, „disposing the backend ends every shell …“)

## 3. Registry und Core

- [x] 3.1 Text eines `CoreError` beim gescheiterten Start (`session/registry.test.ts`, „passes the reason of a CoreError from the backend …“)
- [x] 3.2 `runCore` registriert das Windows-Backend; Shutdown ohne Stop beendet die Shell, nächster Core `Interrupted`, Neustart, Verlauf (`bin/run-core-windows.test.ts`, „[V1-15] ends the shells on core.shutdown without stop …“)
- [x] 3.3 Autostart mit Windows-Profil, Shutdown mit Stop (`bin/run-core-windows.test.ts`, „[V1-15] starts a Windows autostart profile once …“); vorher rot („Could not stop sessions“)
- [x] 3.4 `defaultCwd` unverändert, Kommentar und Spec: `~` ist für Windows der Benutzerordner (`workspace/default-cwd.test.ts`)

## 4. Desktop

- [x] 4.1 `persistenceLimit`, Text der unterbrochenen Windows-Session, Warnungstext (`renderer/session-display.test.ts`)
- [x] 4.2 Formular „Neue Session“ (`renderer/new-session.test.ts`)
- [x] 4.3 Projektdialog mit Backend, Windows-Projekt startet eine Windows-Shell (`renderer/sidebar-model.test.ts`, „new project dialog (#65)“)
- [x] 4.4 Schließen-Dialog: Zahl der Windows-Shells und Satz (`shared/quit-decision.test.ts`, `main/quit-flow.test.ts`, `main/quit-prompt.test.ts`)
- [x] 4.5 Prüfmodus mit Windows-Shell (`main/smoke-test.test.ts`, „windowsShellCheck (#65)“, „checks a Windows shell in its own core …“); Lauf der entpackten App mit `--smoke-test`
- [x] 4.6 Szenengruppe `windows` mit Sichtbarkeitsselektoren (`main/screenshot.test.ts`, `main/scene-prefixes.test.ts`, Lauf `--scenes windows`)
- [x] 4.7 Rohpuffer-Snapshot ohne Kürzen am Ende (`renderer/terminal-controller.test.ts`, „keeps the line breaks at the end of a raw snapshot …“; `renderer/session-display.test.ts`, „takes the snapshot of a Windows session as raw output …“); aufgefallen in `39-windows-restarted.png`
- [x] 4.8 Knopf „Neue Session“ statt „Neue WSL-Session“ im Leerzustand und in der Sidebar; geprüft durch die Szenen `03-new-window-empty-form.png` und `34-windows-new-session.png`

## 5. Dokumentation und Abnahme

- [x] 5.1 Nachträge in ADR 0001, 0003, 0005, 0008, Lessons und `AGENTS.md`; geprüft durch `npm run format:check` und den Review
- [x] 5.2 V1-15 in `docs/acceptance.md` mit Nachweisen; geprüft durch `npm run acceptance`
