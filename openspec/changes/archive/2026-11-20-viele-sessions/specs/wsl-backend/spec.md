## MODIFIED Requirements

### Requirement: Detach, Existenz und Wiederanbinden

`dispose()` der PTY SHALL nur den tmux-Client beenden; die tmux-Session läuft weiter, ohne PTY-Ende. `exists` MUST ohne PTY prüfen und `true` nur für eine Session mit lebendem Programm liefern. `listLive` MUST dasselbe für viele Sessions mit einem `tmux list-sessions` je Distro beantworten, bei gescheitertem Aufruf `undefined`. `attach` MUST eine neue PTY an die bestehende Session hängen. `snapshot` MUST den Bildschirminhalt mit Farben und Cursor liefern, für eine fehlende Session keinen.

#### Scenario: Detach und Reattach mit Snapshot

- **GIVEN** eine laufende Session, die einen Marker ausgegeben hat
- **WHEN** die PTY mit `dispose()` geschlossen wird
- **THEN** meldet `exists` `true`, `snapshot` enthält den Marker und `attach` liefert eine PTY, die Eingaben annimmt

#### Scenario: Reattach trotz fehlendem Arbeitsverzeichnis

- **GIVEN** eine laufende Session, deren `LaunchSpec.cwd` nicht mehr existiert
- **WHEN** `attach` aufgerufen wird
- **THEN** hängt es eine neue PTY an die Session (der Aufruf erfolgt aus `~`)

#### Scenario: Viele Sessions mit einem Aufruf

- **GIVEN** zwei laufende Sessions, eine Session mit beendetem Programm (`remain-on-exit`) und eine ID ohne tmux-Session, alle in derselben Distro
- **WHEN** `listLive` für alle vier aufgerufen wird
- **THEN** führt das Backend genau einen `wsl.exe`-Aufruf `tmux -L <socket> list-sessions -F '#{session_name} #{pane_dead}'` aus und liefert genau die zwei laufenden

#### Scenario: Kein tmux-Server

- **GIVEN** ein Socket ohne laufenden tmux-Server
- **WHEN** `listLive` aufgerufen wird
- **THEN** liefert es eine leere Menge

#### Scenario: Aufruf scheitert

- **GIVEN** zwei Distros, von denen eine `list-sessions` mit einem WSL-Fehler beantwortet
- **WHEN** `listLive` für Sessions beider Distros aufgerufen wird
- **THEN** liefert es `undefined` und ändert am Keepalive nichts

### Requirement: Keepalive je Distro

Solange das Backend mindestens eine Session einer Distro kennt (gestartet, angehängt oder per `exists` oder `listLive` gefunden), SHALL je Distro ein Prozess `wsl.exe -d <distro> --cd ~ --exec tmux -L <socket> wait-for termdock-keepalive` ohne PTY laufen, losgelöst vom Core (`detached`), so dass er dessen Ende überlebt. Endet die letzte bekannte Session der Distro (`kill`, Programm-Ende oder `exists` oder `listLive` meldet sie als weg), MUST das Backend den Prozess beenden.

#### Scenario: Session überlebt eine Pause ohne PTY

- **GIVEN** eine Session, deren PTY mit `dispose()` geschlossen wurde
- **WHEN** 25 s lang kein anderer `wsl.exe`-Aufruf läuft
- **THEN** liefert `exists` danach `true`

#### Scenario: Letzte Session endet

- **GIVEN** zwei bekannte Sessions in derselben Distro
- **WHEN** beide beendet werden
- **THEN** läuft der Keepalive nach der ersten weiter und ist nach der zweiten beendet

#### Scenario: Core wird hart beendet

- **GIVEN** ein Core mit einer laufenden WSL-Session und ihrem Keepalive
- **WHEN** der Core-Prozess ohne `core.shutdown` beendet wird (Update, „Task beenden“ im Task-Manager, Absturz) und 30 s vergehen
- **THEN** läuft derselbe Keepalive-Prozess weiter und die tmux-Session existiert

#### Scenario: Verwaister Keepalive endet mit dem tmux-Server

- **GIVEN** ein Keepalive, dessen Core beendet ist
- **WHEN** die letzte tmux-Session seines Sockets endet
- **THEN** endet auch der Keepalive samt seinem `wsl.exe`

#### Scenario: Gebündelt gefundene Sessions halten den Keepalive

- **GIVEN** ein neues Backend und drei gespeicherte Sessions in einer Distro, von denen zwei leben
- **WHEN** `listLive` für alle drei antwortet
- **THEN** läuft nach genau einer Übernahme genau ein Keepalive für die Distro; er läuft weiter, wenn die erste lebende Session endet, und endet mit der zweiten

## ADDED Requirements

### Requirement: Lasttest mit vielen Sessions

Das Skript `scripts/load-test.mjs` SHALL lokal einen isolierten Core (eigene Pipe, temporärer `TERMDOCK_DATA_DIR`, Socket `termdock-test-<pid>-<nonce>`) mit N WSL-Sessions starten (Standard 50, davon 10 mit gedrosselter Ausgabe) und Startzeit, Abgleich beim Neustart, RSS des Core nach 60 s und Echo-Latenz (p50, p95, max) als Tabelle und JSON melden, gegen die Grenzwerte 3 s, 300 MiB und 100 ms. Am Ende MUST es Core, tmux-Server seines Sockets und Datenordner entfernen, auch nach einem Fehler.

#### Scenario: Standardlauf

- **GIVEN** WSL mit tmux und ein gebauter Core
- **WHEN** `node scripts/load-test.mjs` ohne Optionen läuft
- **THEN** startet es 50 Sessions, davon 10 mit Ausgabe, meldet die vier Messwerte mit den Grenzwerten und endet mit Code 0 nur, wenn alle Grenzwerte eingehalten sind

#### Scenario: Aufräumen

- **GIVEN** ein Lauf, der nach dem Anlegen der Sessions scheitert
- **WHEN** das Skript endet
- **THEN** läuft auf seinem Socket kein tmux-Server mehr, sein Core ist beendet und sein Datenordner gelöscht; der Socket `termdock` bleibt unberührt
