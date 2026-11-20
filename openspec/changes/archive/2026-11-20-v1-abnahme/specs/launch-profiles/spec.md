## ADDED Requirements

### Requirement: Interaktive Vollbildprogramme aus einem Profil

Eine Session aus einem Profil, dessen Befehl ein interaktives Vollbildprogramm startet (z. B. `vim`, Claude Code, Codex), SHALL wie eine Shell Eingaben des Schreibers an das Programm geben und dessen Ausgabe an die Views verteilen. Das Programm MUST den Alternate Screen nutzen können. Endet es, SHALL die Session `Exited` mit seinem Exit-Code sein (V1-03).

#### Scenario: vim aus einem Profil

- **GIVEN** ein Profil mit Befehl `["vim", "-u", "NONE", "-N", "-n", "<datei>"]` und eine Session daraus mit angehängter View (WSL)
- **WHEN** vim läuft, die View `ihello-v1-03`, Strg+C und `:wq` sendet
- **THEN** meldet tmux für das Pane den Alternate Screen, der Text steht im Pane und in der Ausgabe der View, die Session ist danach `Exited` mit Exit-Code 0 und die Datei enthält `hello-v1-03`

### Requirement: Autostart bei gleichzeitigem Core-Start

Starten zwei Cores gleichzeitig auf derselben Pipe und demselben Datenordner (z. B. zwei App-Starts), SHALL genau einer laufen und der andere mit `already_running` enden, bevor er Datenbank oder Autostart anfasst. Der Autostart MUST so genau einmal laufen, und alle Clients MUST dieselben Sessions sehen (V1-14).

#### Scenario: Zwei Cores gleichzeitig

- **GIVEN** ein Datenordner mit einem Autostart-Profil und einem Profil ohne Autostart
- **WHEN** zwei Cores gleichzeitig mit derselben Pipe und diesem Datenordner starten
- **THEN** endet einer mit Exit-Code 10 und `already_running`, beide Backends zusammen erhalten genau einen Start, und zwei Clients des laufenden Core listen dieselbe eine Session des Autostart-Profils
