# Tasks

## 1. Keine Geheimnisse in Logs, Antworten und Datenbank

- [x] 1.1 Fix: `session.create` lehnt `launch.env`-Schlüssel mit Geheimnis-Namen mit `bad_request` ab, auch mit `profileId` (`session/secret-env.ts`, `SessionRegistry.create`; Test `ipc/ipc.test.ts` „refuses the same keys in session.create …“, vor dem Fix rot)
- [x] 1.2 Test: Profil mit `TD_TEST_VALUE`, fehlendes `cwd`, Backend-Fehler, `bad_request`, Autostart-Fehler; Wert nicht in Antworten, `core.log`, stderr, Dateien; in der Datenbank nur `launch_profiles.env` und `sessions.env` (`security/secrets.test.ts`)
- [x] 1.3 Test: dieselben Fehler über `DesktopBridge`; Wert nicht in Brücken-Antworten, `desktop.log` und `core.log` (`apps/desktop/src/main/security.test.ts`)
- [x] 1.4 WSL-Test: `env`-Wert mit fehlendem `cwd` nicht in Warnung, Fehlermeldung und `core.log` (`session-management.wsl.test.ts`)

## 2. Argument-Arrays

- [x] 2.1 Test: Quell-Scan von `packages/core/src` und `apps/desktop/src` ohne Befund, die echten Aufrufe in `processes.ts`, `core-process.ts`, `screenshot.ts` und `screenshot-scenario.ts` werden gesehen; Fixtures für `exec`, `shell`, zusammengesetzten Befehl, String-Argumente, `node-pty` und unbekannte Verwendung (`security/argument-arrays.test.ts`)

## 3. Löschen entfernt den Verlauf

- [x] 3.1 Test: Verlauf schreiben, Core neu starten, löschen; `history/<id>/` fehlt, ein dritter Start findet weder Session noch Ordner (`bin/run-core.test.ts`)
- [x] 3.2 WSL-Test: dasselbe mit echter Ausgabe aus tmux (`session-management.wsl.test.ts`)

## 4. Pipe nur für den Benutzer

- [x] 4.1 Test: Standardname aus Benutzer und Domäne des Prozesses (`ipc/pipe-name.test.ts`)
- [x] 4.2 Windows-Test: DACL ohne weitere Trustees, Besitzer ist der Benutzer oder Administratoren (`ipc/pipe-acl.test.ts`)

## 5. Terminal-Ausgabe ist Daten

- [x] 5.1 Test: OSC 52, OSC 8 und Titel gehen unverändert an View, Snapshot und Verlauf, nichts an die PTY, Suche und Log ohne ihren Inhalt (`security/terminal-output.test.ts`)
- [x] 5.2 Test: dieselben Sequenzen durch die Brücke nur als `output`-Events; keine OSC-Handler, kein Clipboard-Addon, kein Link-Öffner, kein `openExternal`; neue Fenster und Navigation verweigert (`apps/desktop/src/main/security.test.ts`)
