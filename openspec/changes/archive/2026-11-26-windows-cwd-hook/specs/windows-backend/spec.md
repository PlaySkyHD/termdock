# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
