# Proposal

## Why

Die Sicherheitsregeln (`.agents/instructions/security.instructions.md`, Konzept Abschnitt „History/Sicherheit“) waren bisher nur durch Reviews abgesichert (#135, Phase 4 „Logging-/Security-Tests“). Beim Schreiben der Tests zeigte sich eine Lücke: `session.create` nahm einen `launch.env`-Schlüssel wie `GITHUB_TOKEN` an und speicherte den Wert im Klartext in der Spalte `sessions.env`, obwohl Profile solche Schlüssel schon ablehnen.

## What Changes

- **Fix:** `SessionRegistry.create` lehnt wie Profile jeden `launch.env`-Schlüssel mit Geheimnis-Namen mit `bad_request` ab, bevor etwas gespeichert oder gestartet wird; das gilt auch für `session.create` mit `profileId` und eigenem `launch`. Die Prüfung liegt in `session/secret-env.ts` und wird von `ProfileService` mitbenutzt.
- Tests, die in der CI laufen:
  - Ein Profil mit einem Token-ähnlichen Wert, ungültigem `cwd`, Backend-Fehler und `bad_request`: Der Wert steht weder in IPC- oder Brücken-Antworten noch in `core.log`, `desktop.log` oder auf stderr; in der Datenbank nur in `launch_profiles.env` und `sessions.env`.
  - Ein Scan der Quellen von `packages/core/src` und `apps/desktop/src` mit dem TypeScript-Parser: kein `exec`/`execSync`, keine `shell`-Option außer `false`, kein zusammengesetzter Programmname, keine Argumente als String (Allowlist mit Begründung, heute leer).
  - Löschen nach einem Core-Neustart entfernt `history/<id>/`, ein dritter Start findet weder Session noch Ordner.
  - Pipe: der Standardname folgt aus Benutzer und Domäne des Prozesses; die DACL nennt außer Benutzer, SYSTEM, Administratoren sowie Everyone und Anonymous (nur lesend) keinen Trustee, Besitzer ist der Benutzer.
  - OSC 52, OSC 8 und Titel-Sequenzen gehen unverändert durch Core und Brücke; nichts wird an die PTY zurückgeschrieben; Main und Renderer haben keinen OSC-Handler, kein Clipboard-Addon, keinen Link-Öffner und kein `openExternal`.
- WSL-Integrationstests (`TERMDOCK_WSL_TESTS=1`): Löschen mit echtem Verlauf nach Neustart, `env`-Wert mit fehlendem `cwd`.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `diagnostics`: Werte aus `launch.env` stehen in keinem Log und keiner Fehlerantwort.
- `session-persistence`: `session.create` lehnt Geheimnis-Schlüssel ab; Löschen nach einem Neustart.
- `wsl-backend`: Argument-Arrays werden durch einen Quell-Scan in der CI geprüft.
- `core-ipc`: Pipe-Name des laufenden Kontos, DACL ohne weitere Trustees.
- `session-lifecycle`: Terminal-Ausgabe ist Daten (Core).
- `desktop-shell`: Escape-Sequenzen nur im Terminal-Emulator (Desktop).

## Impact

`packages/core` (neu: `session/secret-env.ts`, `security/*.test.ts`; geändert: `session/registry.ts`, `workspace/profile-service.ts`, Tests in `ipc/` und `bin/`, `session-management.wsl.test.ts`), `apps/desktop` (neu: `main/security.test.ts`). Protokoll und IPC-Vertrag bleiben unverändert; ein Client, der bisher `GITHUB_TOKEN` o. Ä. in `session.create` schickte, erhält jetzt `bad_request` (die App tut das nicht).
