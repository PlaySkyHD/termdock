# Proposal

## Why

Die Review von PR #146 (#135) ließ vier Folgepunkte zu den Geheimnis-Regeln offen (Issue #149). Keiner ist heute ein Leck, aber jeder ist eine Lücke in der Regel „Keine Geheimnisse im Klartext“:

- Sessions, die vor #146 mit einem Schlüssel wie `GITHUB_TOKEN` angelegt wurden, behalten den Wert in `sessions.env`, und `restart` übernimmt ihn.
- Die Schlüssel-Heuristik erkennt `STRIPE_KEY`, `GITHUB_PAT`, `DB_PASS` und URLs mit Passwort (`postgres://u:p@host`) nicht.
- `runWsl` meldet bei leerem stderr Nodes `Command failed: wsl.exe …` mit dem ganzen argv. Sobald ein Wert aus `launch.env` über `runWsl` läuft, stünde er in Fehlerantworten und `core.log`.
- Der Quell-Scan der Argument-Arrays übersieht `const { exec } = cp` und `cp["exec"]`, obwohl die Spec „auch über Aliase“ sagt.

## What Changes

- **Altbestand:** Eine Migration (Schema-Version 4) entfernt aus `sessions.env` jeden Eintrag, den die gemeinsame Regel als Geheimnis erkennt, und schreibt je Eintrag eine Warnung mit Session-ID und Schlüssel in `core.log`, nie mit dem Wert. Eine Zeile mit unlesbarem JSON bleibt unverändert.
- **Heuristik** (`session/secret-env.ts`, gilt für Profile und Sessions): zusätzlich Namen auf `_PAT`, `_PASS`, `_KEY` und Werte, die eine URL mit Passwort im Userinfo-Teil sind. Ausgenommen sind `…PUBLIC_KEY`; `KEYBOARD`, `KEYMAP`, `SSH_AUTH_SOCK`, `PATH`, `XDG_*` bleiben erlaubt.
- **`runWsl`:** Bei leerem stderr meldet es nur `wsl.exe failed: exit code N`, das Signal oder den Startfehler-Code, nie argv. `parseCwdCheck` kennt den neuen Text.
- **Scanner:** erkennt Aliase über Namespace-Import (`const { exec } = cp`, `const run = cp.exec`, `cp["exec"]()`); nicht verfolgbare Zugriffe (`cp[name]`, `...rest`, `register(cp.spawn)`) sind Befunde.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `launch-profiles`: erweiterte Geheimnis-Regel.
- `session-persistence`: erweiterte Regel, Migration des Altbestands.
- `wsl-backend`: Fehlertext von `wsl.exe`-Aufrufen, Scan über Namespace-Aliase.

## Impact

`packages/core` (`session/secret-env.ts`, `storage/migrations.ts`, `storage/database.ts`, `bin/run-core.ts`, `backend/wsl/processes.ts`, `backend/wsl/commands.ts`, Tests). Profile mit einem Wert wie `postgres://u:p@host` oder einem Schlüssel `*_KEY` werden künftig beim Anlegen abgelehnt; bestehende Profile bleiben unberührt (sie wurden seit Phase 3 geprüft, nur mit der engeren Regel). Das Protokoll bleibt unverändert.
