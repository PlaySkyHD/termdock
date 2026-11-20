## MODIFIED Requirements

### Requirement: Befehle als Argument-Arrays

Alle Aufrufe von `wsl.exe` und `tmux` SHALL Argument-Arrays sein, ohne Login-Shell. Ohne `command` MUST die Login-Shell der Distro in der Session laufen, mit `command` dieses Programm mit genau diesen Argumenten, ohne dass eine Shell sie interpretiert. Ein Test in der CI MUST die Quellen von Core und Desktop prüfen: kein `exec`, keine `shell`-Option außer `false`, kein zusammengesetzter Programmname; Ausnahmen nur in einer Allowlist mit Grund.

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
