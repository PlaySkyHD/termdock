## ADDED Requirements

### Requirement: Aktuelles Verzeichnis aus tmux

Das WSL-Backend SHALL `currentCwd(id, spec)` anbieten: ein Aufruf `wsl.exe -d <distro> --cd ~ --exec tmux -L <socket> has-session -t =td-<id> ; display-message -p -t =td-<id>: '#{pane_current_path}'` als Argument-Array mit `WSL_UTF8=1` und höchstens 5 s Laufzeit. Die Terminal-Ausgabe der Session wertet es dafür nicht aus.

#### Scenario: Argumente

- **GIVEN** Session `s1` in Distro `Ubuntu` auf Socket `termdock`
- **WHEN** `currentCwd` aufgerufen wird
- **THEN** startet genau ein `wsl.exe` mit `-d Ubuntu --cd ~ --exec tmux -L termdock has-session -t =td-s1 ; display-message -p -t =td-s1: #{pane_current_path}`

#### Scenario: Echte Session

- **GIVEN** `TERMDOCK_WSL_TESTS=1`, ein Core mit eigenem Socket aus `wslTestSocket()` und ein Client mit einer View einer WSL-Session
- **WHEN** der Client `cd /tmp` eingibt
- **THEN** erhält er innerhalb von 15 s `session.cwdChanged` mit `/tmp`, und `session.list` nennt `currentCwd: "/tmp"`

### Requirement: Antwort der Verzeichnisabfrage

`currentCwd` SHALL den Pfad ohne den Zeilenumbruch am Ende liefern, wenn er mit `/` beginnt und `isValidCurrentCwd` besteht, sonst `undefined`. Fehler, Zeitüberschreitung und eine fehlende Session MUST `undefined` ergeben; die Methode lehnt nie ab.

#### Scenario: Antwort von tmux

- **GIVEN** tmux antwortet `/home/nic/Projekt Ä\n`
- **WHEN** `currentCwd` endet
- **THEN** ist das Ergebnis `/home/nic/Projekt Ä`

#### Scenario: Unbrauchbare Antwort

- **GIVEN** tmux antwortet leer, mit einem relativen Pfad, mit einem Pfad über 512 Zeichen oder mit einem Steuerzeichen im Pfad, oder der Aufruf scheitert, läuft in die Zeitüberschreitung oder findet die Session nicht
- **WHEN** `currentCwd` endet
- **THEN** ist das Ergebnis `undefined`, ohne Fehler
