## MODIFIED Requirements

### Requirement: Befehle als Argument-Arrays

Alle Aufrufe von `wsl.exe` und `tmux` SHALL Argument-Arrays sein, ohne Login-Shell. Ohne `command` MUST die Login-Shell der Distro in der Session laufen, mit `command` dieses Programm mit genau diesen Argumenten, ohne dass eine Shell sie interpretiert. Ein Test in der CI MUST die Quellen von Core und Desktop prüfen: kein `exec`, keine `shell`-Option außer `false`, kein zusammengesetzter Programmname, auch nicht über Aliase eines Namespace-Imports; Ausnahmen nur in einer Allowlist mit Grund.

#### Scenario: Argumente bleiben wörtlich

- **GIVEN** ein `command` mit einem Argument, das `$HOME` und `;` enthält
- **WHEN** die Session startet
- **THEN** erhält das Programm das Argument unverändert

#### Scenario: Argument endet auf Semikolon

- **GIVEN** ein `command` oder ein Umgebungswert, dessen Argument auf `;` endet (auch ein einzelnes `;` oder `x;`)
- **WHEN** die Session startet
- **THEN** erhält das Programm das Argument unverändert und tmux führt keinen weiteren Befehl daraus aus

#### Scenario: Ungültige Session-ID

- **WHEN** eine Session mit einer ID gestartet werden soll, die andere Zeichen als Buchstaben, Ziffern, `-` und `_` enthält
- **THEN** lehnt das Backend ab, ohne `wsl.exe` aufzurufen

#### Scenario: Quell-Scan der Prozessaufrufe

- **GIVEN** die Quellen von `packages/core/src` und `apps/desktop/src` ohne Tests
- **WHEN** der Scan alle Aufrufe von `child_process` und `node-pty` (auch über Aliase und `import("node-pty")`) prüft
- **THEN** findet er die Aufrufe in `processes.ts`, `core-process.ts` und den Screenshot-Modulen und keinen Befund, und Beispiele mit `exec(`, `shell: true`, einem Template oder `+` als Befehl und Argumenten als String meldet er

#### Scenario: Aliase über einen Namespace-Import

- **GIVEN** `import * as cp from "node:child_process"`
- **WHEN** der Scan `const { exec } = cp`, `const run = cp.exec`, `cp["exec"]("ls")`, `cp[name]("ls")` oder `register(cp.spawn)` sieht
- **THEN** meldet er jeden Fall (`exec` oder `unchecked-use`), und `const { spawn } = cp` mit `shell: true` meldet er wie ein benannter Import

## ADDED Requirements

### Requirement: Fehlertext von wsl.exe-Aufrufen ohne Argumente

Meldet ein `wsl.exe`-Aufruf ohne PTY einen Fehler bei leerem stderr, SHALL der Core nur Exit-Code, Signal oder Startfehler-Code melden (`wsl.exe failed: exit code N`), nie die Kommandozeile oder die Argumente. Echte Ausgabe von `wsl.exe` auf stderr MUST unverändert bleiben.

#### Scenario: Wert in den Argumenten

- **GIVEN** ein `wsl.exe`-Aufruf mit `TD_TEST_VALUE=td-test-secret-0000` in den Argumenten, der mit Exit-Code 1 und ohne stderr endet
- **WHEN** der Aufruf den Fehler meldet
- **THEN** lautet der Fehlertext `wsl.exe failed: exit code 1` und enthält weder Argumente noch den Wert

#### Scenario: Stummer Exit 1 der Verzeichnisprüfung

- **GIVEN** das Ergebnis von `test -d <cwd>` mit Exit-Code 1 und dem Text `wsl.exe failed: exit code 1`
- **WHEN** der Core das Ergebnis liest
- **THEN** gilt das Verzeichnis als fehlend; bei anderem stderr gilt es als unbekannt
