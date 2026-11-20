# Tasks

## 1. Übersicht und Prüfung

- [x] 1.1 `docs/acceptance.md` mit Tabelle und je Kriterium Abschnitt, Status und Nachweisen; 15 als „offen, #65“ (Prüfung: `npm run acceptance` grün)
- [x] 1.2 `scripts/acceptance-check.mjs`: Kriterien aus dem Konzept, Abschnitte, Tabelle, Status, Tests, Szenen, Präfixe in beide Richtungen (Tests `scripts/acceptance-check.test.mjs`: vollständige Übersicht, fehlender Abschnitt, kein Nachweis, offener Status mit Nachweisen, unbekannter Status, falscher Testname, fehlendes Präfix, fehlende Datei und Szene, nicht genannter Test, abweichender Text und Status, Status passt nicht zu den Nachweisen, unbekanntes Listenformat, doppeltes Kriterium, Exit-Codes 0/1/2)
- [x] 1.3 `npm run test:hooks` nimmt die Tests des Skripts auf, `npm run acceptance` läuft im CI-Job `check` (Prüfung: `npm run test:hooks` und der neue CI-Schritt grün)

## 2. Benennung

- [x] 2.1 Bestehende Nachweis-Tests tragen `[V1-<nn>]`, ohne Änderung ihres Inhalts; Dateien von PR #148 bleiben unberührt (Prüfung: `npm test -w packages/core`, `npm test -w apps/desktop`, `npm run acceptance`)

## 3. Neue Tests

- [x] 3.1 V1-03: `vim` aus einem Startprofil mit Alternate Screen, Eingabe, Ausgabe und Ende (Test `[V1-03] runs vim from a profile …` in `packages/core/src/e2e.wsl.test.ts`, `TERMDOCK_WSL_TESTS=1`)
- [x] 3.2 V1-12: gruppenlose Session anlegen, verschieben und zurück, archivieren, löschen (Test `[V1-12] creates a session without group …` in `packages/core/src/session-management.wsl.test.ts`, `TERMDOCK_WSL_TESTS=1`)
- [x] 3.3 V1-14: zwei Cores gleichzeitig, ein Autostart, eine Session (Test `[V1-14] two cores started at once …` in `packages/core/src/bin/run-core.test.ts`)
