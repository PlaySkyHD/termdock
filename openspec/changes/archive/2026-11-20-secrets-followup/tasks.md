# Tasks

## 1. Heuristik

- [x] 1.1 `secret-env.ts` erkennt `_PAT`, `_PASS`, `_KEY` und URLs mit Passwort, nicht `KEYBOARD`, `KEYMAP`, `SSH_AUTH_SOCK`, `PATH`, `XDG_*`, `PUBLIC_KEY` (Test `session/secret-env.test.ts`)
- [x] 1.2 Die Ablehnung nennt den Schlüssel, nie den Wert (Test `session/secret-env.test.ts`)

## 2. Altbestand

- [x] 2.1 Migration 4 entfernt Geheimnis-Einträge aus `sessions.env`, lässt anderes und unlesbare Zeilen, warnt mit Session-ID und Schlüssel ohne Wert (Test `storage/database.test.ts`)
- [x] 2.2 `run-core` schreibt die Warnungen als `warn` in `core.log` (`bin/run-core.ts`, geprüft über `onMigrationWarning` im Test 2.1)

## 3. runWsl

- [x] 3.1 Fehlertext nur mit Exit-Code, Signal oder Startfehler, nie mit argv (Test `backend/wsl/processes.test.ts`)
- [x] 3.2 `parseCwdCheck` liest den neuen Text als stumm (Test `backend/wsl/commands.test.ts`)

## 4. Scanner

- [x] 4.1 Der Scan meldet `const { exec } = cp`, `const run = cp.exec`, `cp["exec"]()` und nicht verfolgbare Namespace-Zugriffe (Test `security/argument-arrays.test.ts`)
