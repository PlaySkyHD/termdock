# Design

## Kontext

Issue #133 verlangt je Ausfall einen Test und die Behebung dessen, was dabei falsch ausfällt. Echte Ausfälle (WSL abschalten, Platte füllen) sind auf dem Host verboten oder nicht reproduzierbar; die Tests lösen sie gezielt und isoliert aus.

## Entscheidungen

- **tmux-Server stirbt:** nur `kill-server` auf dem Socket der Testdatei (`wslTestSocket()`, `killWslTestServer`), nie `termdock`. Ob PTYs übrig sind, prüft der Test auf beiden Seiten: Linux (`pgrep -f -- "-L <socket>"`) und Windows (`wsl.exe`-Prozesse, deren Befehlszeile den Socket nennt, über `Get-CimInstance`). Die IPC kennt kein `session.restart`; den Neustart prüft der Test daher an der Registry mit echtem `WslBackend`.
- **Harter Kill:** Der Core muss ein eigener Prozess sein, sonst beendet der Kill den Test. Ein kleines Einstiegsskript `src/test/flooding-core.ts` startet `runCore` mit einem FakeBackend, dessen PTY jede Millisekunde Zeilen mit fortlaufender Nummer ausgibt; `tsc -b` baut es nach `dist/test/` (in der CI läuft `npm run typecheck` vor den Tests). Der Kill über `ChildProcess.kill()` ist unter Windows `TerminateProcess`. Jede Layout-Speicherung trägt ihre Nummer im Dokument (`window-<n>`), so dass eine halbe Revision (Revision ohne ihr Dokument) auffiele.
- **Datenordner voll:** Für SQLite gibt es keinen verlässlichen echten Weg, den Schreibfehler zur Laufzeit auszulösen. `RunCoreOptions.openStorage` lässt den Test die Repositories umhüllen und jeden Schreibzugriff mit dem Fehler werfen, den SQLite bei voller Platte meldet. Für den Verlauf reicht ein echter Fehler: eine Datei an der Stelle von `history/`.
- **Fehlercode:** Speicherfehler bleiben `internal` (stabiler Code aus ADR 0002, Grund im Log). Ein eigener Code wäre eine Protokolländerung ohne Nutzen für diese Tests.
- **Log je Fehlerstrecke:** `HistoryStore` merkt sich je Session, ob das letzte Schreiben scheiterte, und ruft `onError` nur beim ersten Fehler; ein gelungenes Schreiben setzt das zurück. `stats` zählt verworfene Einträge weiter vollständig.
- **Renderer-Absturz:** als Screenshot-Szene, weil nur Electron den Absturz auslöst. Präfix 31–33 (kein Zehnerblock ist mehr ganz frei; im Block 30 steht nur `30-…` der Suche, der Block 90 gehört zu `restart`), eigene Gruppe `crash` vor `restart`, weil `restart` den Core beendet.

## Risiken

- Der Hard-Kill-Test braucht ein aktuelles `dist/`; ohne Build scheitert er mit einer Meldung, die `npm run typecheck` nennt.
