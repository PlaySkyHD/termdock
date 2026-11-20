## ADDED Requirements

### Requirement: Gemeinsamer Leser für die ConPTY-Ausgabe

Der Core SHALL die Ausgabe-Pipes aller PTYs über genau einen Worker-Thread lesen statt über einen Worker je PTY (ADR 0008). Eine PTY MUST erst starten, wenn dieser Worker läuft. Endet eine PTY, MUST der Worker ihre Pipe schließen, auch ohne `kill`. 20 PTYs MUST den RSS des Core um weniger als 60 MiB erhöhen, und `kill()` MUST unter voller Ausgabe sofort zurückkehren.

#### Scenario: Viele PTYs

- **GIVEN** ein Core-Prozess mit einer laufenden PTY
- **WHEN** 20 weitere PTYs mit `cmd.exe` starten
- **THEN** laufen alle über denselben Worker-Thread, und der RSS wächst um weniger als 60 MiB

#### Scenario: Beenden unter voller Ausgabe

- **GIVEN** fünf PTYs, deren Programme ohne Pause Zeilen ausgeben
- **WHEN** der Core jede PTY mit `kill()` beendet
- **THEN** kehrt jeder Aufruf in weniger als 1 s zurück, jede PTY meldet ihr Ende genau einmal, und der Worker hält keine Pipe mehr

#### Scenario: Lasttest

- **GIVEN** WSL mit tmux und ein gebauter Core
- **WHEN** `node scripts/load-test.mjs` mit 50 Sessions läuft
- **THEN** liegt der RSS des Core unter 300 MiB, der Abgleich unter 3 s und das Echo p95 unter 100 ms

### Requirement: Leser nur für node-pty 1.1.0

Der Core SHALL den Leser nur in node-pty 1.1.0 einsetzen. Bei jeder anderen Version MUST er eine Zeile auf stderr melden und node-pty unverändert lassen. Ein Test MUST fehlschlagen, wenn die installierte Version nicht 1.1.0 ist. Ohne laufenden Worker MUST das Anlegen einer Verbindung mit einem Fehler scheitern, statt den Core anzuhalten.

#### Scenario: Andere Version

- **GIVEN** node-pty meldet die Version 1.2.0
- **WHEN** der Core den Leser einsetzen will
- **THEN** meldet er genau eine Zeile mit der gefundenen Version, und `ConoutConnection` bleibt die von node-pty

#### Scenario: Installierte Version

- **GIVEN** die Abhängigkeiten aus `package-lock.json`
- **WHEN** der Test die Version von node-pty liest
- **THEN** ist sie 1.1.0

#### Scenario: Kein Worker

- **GIVEN** ein eingesetzter Leser, dessen Worker nicht läuft
- **WHEN** node-pty eine Verbindung anlegt
- **THEN** wirft das Anlegen einen Fehler

### Requirement: Absturz des Lesers

Endet der Worker unerwartet, SHALL der Core den Prozess jeder PTY beenden und ihr Ende genau einmal ohne Exit-Code melden; eine WSL-Session wird dann wie nach einem verlorenen Client neu angehängt. Zustand, Views und Schreiber MUST bleiben, je Session MUST genau ein tmux-Client laufen. Die nächste PTY MUST einen neuen Worker starten.

#### Scenario: PTYs ohne WSL

- **GIVEN** drei PTYs mit `cmd.exe`
- **WHEN** der Worker abstürzt
- **THEN** melden alle drei ihr Ende genau einmal, ihre Prozesse sind beendet, und eine neue PTY läuft mit einem neuen Worker

#### Scenario: WSL-Sessions

- **GIVEN** zwei laufende WSL-Sessions mit je einer schreibenden View
- **WHEN** der Worker abstürzt
- **THEN** hat jede Session einen neuen und nur einen tmux-Client, Eingaben kommen an, beide bleiben `Running` mit ihrem Schreiber, und die Zahl der `wsl.exe`-Prozesse ist dieselbe wie vorher
