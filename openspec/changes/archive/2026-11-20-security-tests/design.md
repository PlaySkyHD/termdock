# Design

## Kontext

#135 verlangt Tests für die Sicherheitsregeln. Sie sollen in der CI laufen (Windows-Runner ohne WSL); WSL-Teile laufen lokal mit `TERMDOCK_WSL_TESTS=1`.

## Entscheidungen

- **Echte Kette statt Einzelteile.** Die Geheimnis- und Escape-Tests starten `runCore` mit `FakeBackend`, eigenem Pipe-Namen und Temp-Datenordner und gehen im Desktop-Test zusätzlich durch `DesktopBridge` mit `createDesktopLogger`. Fehlgeschlagene Brücken-Aufrufe loggt der Test wie `main.ts`, so dass `desktop.log` echte Zeilen enthält.
- **Wert ohne Geheimnis-Namen.** Der Testwert `td-test-secret-0000` steht unter `TD_TEST_VALUE`; `redact` erkennt ihn weder am Namen noch an der Form. Ein Treffer im Log wäre also ein echtes Leck, nicht nur eine fehlende Schwärzung.
- **Datenbank über SQL lesen.** Der Test liest alle Zellen aller Tabellen (WAL-Inhalte eingeschlossen) und erlaubt den Wert nur in `launch_profiles.env` und `sessions.env`. Alle anderen Dateien im Datenordner werden als Bytes durchsucht.
- **Quell-Scan mit dem TypeScript-Parser** (`typescript` ist schon Dev-Abhängigkeit). Er folgt Imports aus `node:child_process` und `node-pty` (auch `import("node-pty")`), Aliasen (`promisify(execFile)`, `options.spawn ?? nodeSpawn`, Parameter-Default) und `const`-Werten der Datei. Als zusammengesetzt gilt ein Template mit Platzhaltern, `+`, ein Aufrufergebnis oder ein Literal mit Leerraum; ein Name oder eine Eigenschaft von außen (`options.execPath`) gilt als Pfad. Eine Funktion, die anders weitergereicht wird, und ein dynamischer `child_process`-Import sind Befunde (`unchecked-use`). Der Scan deckt auch `apps/desktop/src` ab, weil dort Screenshot-Läufe `wsl.exe` aufrufen.
- **Pipe-Name.** Der Name enthält nicht die SID, sondern den bereinigten Benutzernamen und einen Hash über `<Domäne>\<Benutzer>` (bestehende Anforderung „Pipe-Name pro Konto“). Das Issue nennt die SID; der Test prüft den festgelegten Namen. Der Zugriffsschutz liegt in der DACL, deren Windows-Test erweitert wird.
- **Fix in der Registry.** Die Prüfung auf Geheimnis-Schlüssel sitzt in `SessionRegistry.create`, weil alle Wege dorthin führen (`session.create` mit und ohne Profil, Autostart). Ein Neustart gespeicherter Sessions prüft nicht erneut: Er speichert nichts Neues.

## Risiken

- Der Quell-Scan ist eine Heuristik ohne Scope-Analyse. Er übersieht z. B. einen über ein Objekt weitergereichten Optionswert; deshalb meldet er unbekannte Verwendungen lieber, als sie zu übergehen.
- Everyone und Anonymous dürfen die Pipe weiter lesend öffnen (ADR 0002); ein fremdes Konto kann so Handshake-Plätze belegen. Das abzustellen braucht ein Native-Modul (eigener Change).
