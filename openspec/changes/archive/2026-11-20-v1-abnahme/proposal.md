# Proposal

## Why

Die 15 V1-Abnahmekriterien (`docs/concept/v1-konzept.txt`, Abschnitt 10) waren über Unit-, WSL- und Screenshot-Tests verstreut, ohne Übersicht, die sie zuordnet (#132, Phase 4 „Abnahmetests“). Für drei Kriterien fehlte ein Nachweis: 03 (interaktive CLI aus einem Startprofil), 12 (gruppenlose Sessions über den ganzen Lebenszyklus gegen WSL) und 14 (zwei gleichzeitige Core-Starts ohne doppelten Autostart).

## What Changes

- Neue Übersicht `docs/acceptance.md`: je Kriterium Nummer, Text, Status und Nachweis (Testdatei und Testname, Screenshot-Szene oder manueller Schritt). Kriterium 15 steht als „offen, #65“.
- Tests, die ein Kriterium belegen, tragen das Präfix `[V1-<nn>]` im Namen. Bestehende Tests werden nur umbenannt, nicht neu geschrieben; Dateien des offenen PR #148 (Keepalive) bleiben unberührt.
- Neues Skript `scripts/acceptance-check.mjs` mit Tests (`scripts/acceptance-check.test.mjs`, Teil von `npm run test:hooks`); es läuft als eigener Schritt im CI-Job `check` (`npm run acceptance`).
- Neue Tests:
  - 03: WSL-Test startet `vim` aus einem Startprofil, prüft Alternate Screen, Eingabe, Ausgabe in der View und sauberes Ende.
  - 12: WSL-Test legt eine gruppenlose Session an, verschiebt sie in einen Workspace und zurück, archiviert und löscht sie.
  - 14: Zwei Cores starten gleichzeitig auf derselben Pipe und demselben Datenordner; einer läuft, einer endet mit `already_running`, der Autostart läuft genau einmal.

## Capabilities

### New Capabilities

- `acceptance`: Übersicht der V1-Abnahme und ihre Prüfung in der CI.

### Modified Capabilities

- `launch-profiles`: Interaktive Vollbildprogramme aus einem Profil; Autostart bei gleichzeitigem Core-Start.

## Impact

Neu: `docs/acceptance.md`, `scripts/acceptance-check.mjs`, `scripts/acceptance-check.test.mjs`. Geändert: `package.json` (`test:hooks`, `acceptance`), `.github/workflows/ci.yml`, Testnamen in `packages/core` und `apps/desktop`, neue Tests in `e2e.wsl.test.ts`, `session-management.wsl.test.ts` und `bin/run-core.test.ts`. Kein Produktcode, kein Protokoll ändert sich.
