# windows-backend Specification

## Purpose
Legt fest, wie der Core Windows-Shells (`pwsh`, `powershell`, `cmd`) über node-pty und ConPTY startet, mit Ein- und Ausgabe, Größe, Verzeichnis und Umgebung versorgt, beendet und abbaut, und dass sie ohne Persistenz nur so lange laufen wie der Core (ADR 0001, ADR 0003).

## Requirements

### Requirement: Start der Windows-Shell

Das Windows-Backend SHALL eine Session in einer ConPTY von node-pty mit `useConptyDll: true` starten, über `spawnConpty` (gemeinsamer Leser, Schließ-Schlange). `pwsh` MUST `pwsh.exe -NoLogo`, `powershell` `powershell.exe -NoLogo` und `cmd` `cmd.exe` ausführen, mit vollem Pfad aus bekannten Orten oder absoluten `PATH`-Verzeichnissen und als Argument-Array; ohne `launch.command` kommen bei PowerShell die Argumente des Prompt-Hooks dazu. `launch.command` MUST direkt laufen, ohne Shell.

#### Scenario: cmd mit Ein- und Ausgabe

- **GIVEN** ein Windows-Backend auf Windows ohne WSL
- **WHEN** die Registry eine Session `{ backend: "windows", shell: "cmd", cwd: <ordner> }` anlegt, eine View anhängt und `cd` eingibt
- **THEN** ist die Session `Detached`, nach dem Anhängen `Running`, und die Ausgabe nennt `<ordner>`

#### Scenario: Befehl als Argument-Array

- **GIVEN** `launch.command` ist `["cmd.exe", "/d", "/c", "echo arg-65 & exit 4"]`
- **WHEN** die Session startet
- **THEN** zeigt die Ausgabe `arg-65`, und die Session wird `Exited` mit Exit-Code 4

#### Scenario: Suche ohne relative Pfade

- **GIVEN** ein `PATH` mit einem relativen, einem leeren, einem gequoteten und zwei absoluten Verzeichnissen
- **WHEN** das Backend `pwsh` sucht
- **THEN** prüft es den Ordner von PowerShell 7, dann nur die absoluten Verzeichnisse in ihrer Reihenfolge und nimmt das erste mit `pwsh.exe`

### Requirement: Suche ohne Blockieren

Die Suche nach Shell und Programm SHALL asynchron laufen, alle Orte zugleich, jeden höchstens 2 s; ein Ort ohne Antwort zählt als leer. Ein App Execution Alias (Store-Installation) MUST als Datei zählen. Ein Programm aus `launch.command` SHALL als absoluter Pfad oder Name in `PATH` mit `.exe` oder `.com` gefunden werden; fehlt es oder ist es eine `.cmd`/`.bat`-Datei, MUST der Start mit einem `CoreError` scheitern, der das sagt.

#### Scenario: Netzlaufwerk im PATH

- **GIVEN** ein `PATH`, dessen erstes Verzeichnis ein nicht antwortendes Netzlaufwerk ist, und `pwsh.exe` im zweiten
- **WHEN** das Backend `pwsh` sucht
- **THEN** findet es `pwsh.exe` im zweiten Verzeichnis in unter 1 s, und der Hauptthread blockiert nicht

#### Scenario: Batch-Datei als Befehl

- **GIVEN** `launch.command` ist `["npm", "run", "dev"]`, und in `PATH` liegt nur `npm.cmd`
- **WHEN** ein Client die Session anlegt
- **THEN** startet kein Prozess, und die Meldung sagt, dass `npm.cmd` eine Batch-Datei ist und als `["cmd.exe", "/d", "/c", "npm.cmd", ...]` laufen kann

#### Scenario: Batch-Datei mit absolutem Pfad

- **GIVEN** `launch.command` ist `["C:\\tools\\build.cmd", "x&calc"]`
- **WHEN** ein Client die Session anlegt
- **THEN** startet kein Prozess (`cmd.exe` würde `&calc` ausführen), und die Meldung nennt `build.cmd` als Batch-Datei, auch bei Endung `.BAT`

### Requirement: Fehlende Shell

Ist die gewählte Shell nicht installiert, MUST der Start mit einem `CoreError` `backend_unavailable` scheitern, dessen Text die Shell und die anderen Shells nennt, ohne einen Prozess zu starten; die Session wird `Interrupted`.

#### Scenario: pwsh fehlt

- **GIVEN** ein Rechner ohne `pwsh.exe`
- **WHEN** ein Client eine Session mit `shell: "pwsh"` anlegt
- **THEN** antwortet der Core `backend_unavailable` mit „PowerShell 7 (pwsh.exe) is not installed on this computer: install it or choose powershell or cmd“, und die Session ist `Interrupted`

### Requirement: Standardshell festhalten

Nennt der `LaunchSpec` keine Shell (auch nicht über `defaultShell` der Einstellungen), SHALL `resolveLaunch` `pwsh` eintragen, wenn es installiert ist, sonst `powershell`; die Registry speichert sie.

#### Scenario: Ohne Shell

- **GIVEN** einmal ein Rechner mit PowerShell 7, einmal einer ohne
- **WHEN** ein Client eine Windows-Session ohne `shell` anlegt
- **THEN** hat die Session `shell: "pwsh"` bzw. `shell: "powershell"`, und die Shell läuft mit `-NoLogo`

### Requirement: Arbeitsverzeichnis der Windows-Shell

`~` SHALL der Benutzerordner sein, `~\x` und `~/x` liegen darin; sonst gilt nur ein Laufwerks- oder UNC-Pfad. Ist das Verzeichnis keines, auch wenn die Prüfung länger als 2 s braucht, MUST die Shell im Benutzerordner starten und `start` die Warnung `cwd_missing` mit `path` ohne `distro` geben.

#### Scenario: Fehlendes Verzeichnis

- **GIVEN** ein `cwd`, das es nicht gibt
- **WHEN** die Session startet
- **THEN** hat sie die Warnung `{ code: "cwd_missing", path: <cwd> }`, und `cd` in der Shell zeigt den Benutzerordner

#### Scenario: Netzlaufwerk antwortet nicht

- **GIVEN** ein UNC-Pfad, dessen Prüfung nicht antwortet
- **WHEN** die Session startet
- **THEN** startet die Shell nach höchstens 2 s im Benutzerordner mit der Warnung `cwd_missing`

#### Scenario: Benutzerordner

- **WHEN** eine Session mit `cwd: "~"` startet
- **THEN** läuft die Shell im Benutzerordner ohne Warnung

### Requirement: Umgebung der Windows-Shell

Die Shell SHALL die Umgebung des Core ohne `ELECTRON_RUN_AS_NODE` und ohne jede Variable `TERMDOCK_*` (Pipe, Datenordner, tmux-Socket dieses Core) erhalten, dazu `launch.env`. Ein Name aus `launch.env` MUST die Variable des Core ohne Rücksicht auf Groß- und Kleinschreibung ersetzen.

#### Scenario: Electron-Variable fehlt

- **GIVEN** ein Core mit `ELECTRON_RUN_AS_NODE=1` und `launch.env` `{ TD_VALUE_65: "abc" }`
- **WHEN** die Shell `%TD_VALUE_65%` ausgibt und prüft, ob `ELECTRON_RUN_AS_NODE` gesetzt ist
- **THEN** zeigt sie `abc`, und die Variable ist nicht gesetzt

#### Scenario: Variablen des Core

- **GIVEN** ein Core mit `TERMDOCK_PIPE` und `TERMDOCK_DATA_DIR`
- **WHEN** eine Windows-Shell startet
- **THEN** fehlen beide in ihrer Umgebung, und ein darin gestartetes TermDock nutzt Pipe und Datenordner nach Standard

### Requirement: Größe und Snapshot der Windows-Shell

Nur die schreibende View SHALL tippen und die Größe ändern; die ConPTY übernimmt die neue Größe direkt, ohne Neuzeichnen. Eine später angehängte View MUST die bisherige Ausgabe aus dem Rohpuffer der Registry (256 KiB) als Snapshot erhalten. Die erste DA1-Abfrage der ConPTY MUST beantwortet sein, bevor eine View anhängt.

#### Scenario: Resize

- **GIVEN** eine Session mit einer schreibenden und einer lesenden View
- **WHEN** die lesende tippt oder die Größe ändert und danach die schreibende 97×31 setzt und `mode con` eingibt
- **THEN** sind die ersten beiden `not_writer`, und `mode con` nennt 31 Zeilen und 97 Spalten

#### Scenario: Späte View

- **GIVEN** eine Session, die `early-65` ausgegeben hat
- **WHEN** eine zweite View anhängt
- **THEN** ist sie lesend, und ihr Snapshot enthält `early-65`

### Requirement: Ende der Windows-Shell

Endet die Shell, SHALL die Session `Exited` mit dem Exit-Code der Shell werden. Beendet der Core die Shell, weil er ihre Ausgabe verlor (`lost`), MUST sie ohne Exit-Code enden und `Interrupted` werden; war die Shell schon von selbst beendet, behält sie ihren Exit-Code. `exists` MUST nur wahr sein, solange die Shell in diesem Core läuft, und `attach` MUST scheitern.

#### Scenario: exit 7

- **WHEN** der Benutzer in `cmd` `exit 7` eingibt
- **THEN** ist die Session `Exited` mit `lastExitCode` 7, `exists` ist falsch, und der Prozess läuft nicht mehr

#### Scenario: Verlorene Ausgabe

- **GIVEN** eine laufende Windows-Session
- **WHEN** ihre PTY mit `{ exitCode: 1, lost: true }` endet
- **THEN** ist die Session `Interrupted` ohne `lastExitCode`

### Requirement: Eine Shell je Session

Das Backend SHALL je Session höchstens eine Shell laufen lassen; ein `start` für eine Session mit laufender oder startender Shell MUST scheitern. `session.restart` MUST nach dem Ende genau eine neue Shell starten.

#### Scenario: Zweiter Start

- **GIVEN** eine laufende Windows-Session
- **WHEN** das Backend sie noch einmal starten soll
- **THEN** scheitert der Start mit „already has a shell“, und es läuft weiter genau eine Shell

### Requirement: Kill der Windows-Shell

`kill` SHALL die PTY über die Schließ-Schlange schließen und warten, bis die Shell geendet hat und ihr Ende der Registry gemeldet ist (höchstens 1 s nach dem Schließen), auch wenn die Registry die PTY vorher freigegeben hat. Läuft die Shell danach noch, MUST `kill` scheitern.

#### Scenario: Kill

- **WHEN** ein Client `session.kill` für eine laufende Windows-Session sendet
- **THEN** ist sie `Exited` mit einem Exit-Code, und ihr Prozess läuft nicht mehr

#### Scenario: Shutdown mit Stop

- **GIVEN** eine Windows-Session aus einem Autostart-Profil
- **WHEN** ein Client `core.shutdown { stopSessions: true }` sendet
- **THEN** antwortet der Core ohne Fehler, und die Shell läuft nicht mehr

### Requirement: Abbau des Windows-Backends

`dispose` SHALL alle Shells über die Schließ-Schlange beenden und auf sie warten, höchstens 15 s; danach MUST `start` scheitern. Die Zustände der Sessions bleiben gespeichert.

#### Scenario: Abbau

- **GIVEN** zwei laufende Windows-Sessions
- **WHEN** das Backend abgebaut wird
- **THEN** läuft keine der beiden Shells mehr, und ein späterer Start scheitert mit „closed“

### Requirement: Tests ohne WSL

Die Tests des Windows-Backends SHALL mit echtem `cmd.exe` ohne WSL laufen, auch auf `windows-latest`, und nur eigene Shells beenden.

#### Scenario: CI

- **GIVEN** der CI-Runner `windows-latest` ohne Distro
- **WHEN** `npm test -w packages/core` läuft
- **THEN** laufen die Tests von `backend/windows/backend.test.ts` und `bin/run-core-windows.test.ts` und sind grün

### Requirement: Prompt-Hook von PowerShell

Eine `pwsh`- oder `powershell`-Session ohne `launch.command` SHALL bei jedem Prompt `ESC ] 9 ; 9 ; "<pfad>" ESC \` senden (OSC 9;9). Das Backend MUST dafür `-NoExit -Command <festes Skript>` anhängen; das Skript läuft nach dem Profil des Nutzers und umhüllt die vorhandene `prompt`-Funktion. Es SHALL den Pfad aus `$PWD.ProviderPath` nur beim FileSystem-Provider melden und bei einem Fehler den Prompt unverändert lassen. Das Skript ist eine Konstante ohne Nutzereingaben.

#### Scenario: Argumente

- **GIVEN** eine `pwsh`- oder `powershell`-Session ohne `launch.command`
- **WHEN** das Backend das Programm bestimmt
- **THEN** sind die Argumente `-NoLogo -NoExit -Command <Skript>`, das Skript enthält kein doppeltes Anführungszeichen und keinen Zeilenumbruch, liest `$PWD.ProviderPath` nur für `FileSystem` und führt den Aufruf der alten `prompt` und den Bau der Sequenz je in `try` aus

#### Scenario: Profil und Fehler im Hook

- **GIVEN** ein Profil, das eine eigene `prompt`-Funktion setzt, oder eine, die einen Fehler wirft
- **WHEN** die Shell startet und der Benutzer einen Befehl eingibt
- **THEN** steht die Sequenz vor dem eigenen Prompt, bzw. bleibt die Shell benutzbar

### Requirement: Prompt-Hook von cmd

Eine `cmd`-Session ohne `launch.command` SHALL bei jedem Prompt OSC 9;9 senden. Das Backend MUST dafür `PROMPT` auf `$e]9;9;$P$e\` plus den bisherigen Wert setzen (`launch.env`, Umgebung des Core, sonst `$P$G`). Programm und Argumente von `cmd` MUST unverändert bleiben (BatBadBut-Härtung).

#### Scenario: cmd meldet das Verzeichnis

- **GIVEN** eine Session `{ backend: "windows", shell: "cmd", cwd: <ordner> }` ohne `launch.command`
- **WHEN** die Shell startet und der Benutzer `cd /d <ordner>\sub` eingibt
- **THEN** enthält die Ausgabe `ESC ] 9 ; 9 ; <ordner> ESC \` und danach `ESC ] 9 ; 9 ; <ordner>\sub ESC \`

#### Scenario: PROMPT des Nutzers bleibt dahinter

- **GIVEN** `launch.env` `{ Prompt: "$G " }` und eine `cmd`-Session ohne `launch.command`
- **WHEN** das Backend die Umgebung der Shell bildet
- **THEN** ist `PROMPT` genau `$e]9;9;$P$e\$G ` und kein zweites `Prompt` steht daneben

### Requirement: Kein Hook bei eigenem Befehl

Hat der `LaunchSpec` einen `launch.command`, SHALL das Backend weder Argumente noch Umgebung für den Prompt-Hook ändern.

#### Scenario: Eigener Befehl

- **GIVEN** `launch.command` ist `["C:\\Windows\\System32\\cmd.exe", "/d", "/c", "echo x"]` oder `["pwsh", "-Command", "echo x"]`
- **WHEN** die Session startet
- **THEN** bekommt das Programm genau diese Argumente und eine Umgebung ohne `PROMPT` des Hooks
