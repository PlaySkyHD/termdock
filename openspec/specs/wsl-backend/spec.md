# wsl-backend Specification

## Purpose
Legt fest, wie der Core Terminal-Sessions in WSL über tmux startet, wieder anbindet, prüft, beendet und als Snapshot ausliest, wie der Exit-Code ermittelt wird und wie WSL die Sessions ohne PTY am Leben lässt.

## Requirements

### Requirement: Start im tmux-Socket des Core

Das WSL-Backend SHALL eine Session `<id>` als tmux-Session `td-<id>` auf dem eigenen tmux-Socket (produktiv `termdock`) in der Distro des `LaunchSpec` (sonst der konfigurierten oder der Standard-Distro von WSL) starten. Das Arbeitsverzeichnis MUST der Linux-Pfad aus `LaunchSpec.cwd` sein (`~` erlaubt). Die Session MUST ohne tmux-Statuszeile laufen, so dass das Programm die volle PTY-Größe sieht.

#### Scenario: Start im erwarteten Verzeichnis

- **GIVEN** ein `LaunchSpec` mit `cwd` `/tmp`
- **WHEN** die Session gestartet wird und in ihr `pwd` läuft
- **THEN** zeigt die Ausgabe `/tmp`

### Requirement: Befehle als Argument-Arrays

Alle Aufrufe von `wsl.exe` und `tmux` SHALL Argument-Arrays sein, ohne Login-Shell. Ohne `command` MUST die Login-Shell der Distro in der Session laufen, mit `command` dieses Programm mit genau diesen Argumenten, ohne dass eine Shell sie interpretiert.

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

### Requirement: Ein- und Ausgabe, Größe und Terminal-Abfrage beim Start

Die PTY der Session SHALL Eingaben an das Programm weitergeben, seine Ausgabe liefern und Größenänderungen an tmux weitergeben. Solange von außen noch keine DA1-Antwort (`ESC [ ? … c`) geschrieben wurde, MUST die PTY die erste DA1-Abfrage (`ESC [ c`) selbst mit `ESC [ ? 1 ; 2 c` beantworten und aus der Ausgabe entfernen, damit Start und Wiederanbinden nicht bis zu 3 s auf eine View warten. Getippte Eingabe vor der Abfrage MUST die Antwort nicht verhindern.

#### Scenario: Start ohne View

- **WHEN** eine Session ohne angehängte View startet und sofort eine Eingabe erhält
- **THEN** erscheint deren Echo nach weniger als 3 s

#### Scenario: View hat schon geantwortet

- **GIVEN** von außen wurde bereits eine DA1-Antwort geschrieben
- **WHEN** die DA1-Abfrage der ConPTY eintrifft
- **THEN** antwortet die PTY nicht selbst und reicht die Abfrage weiter

#### Scenario: Resize

- **GIVEN** eine laufende Session
- **WHEN** die PTY auf 100×30 geändert wird
- **THEN** meldet `stty size` in der Session `30 100`

### Requirement: Detach, Existenz und Wiederanbinden

`dispose()` der PTY SHALL nur den tmux-Client beenden; die tmux-Session MUST weiterlaufen und dabei kein PTY-Ende melden. `exists` MUST über `has-session` ohne PTY prüfen und `true` nur für eine Session mit lebendem Programm liefern. `attach` MUST eine neue PTY an die bestehende Session hängen. `snapshot` MUST den sichtbaren Bildschirminhalt mit Farben und die Cursorposition (0-basiert) liefern, für eine nicht vorhandene Session keinen Snapshot.

#### Scenario: Detach und Reattach mit Snapshot

- **GIVEN** eine laufende Session, die einen Marker ausgegeben hat
- **WHEN** die PTY mit `dispose()` geschlossen wird
- **THEN** meldet `exists` `true`, `snapshot` enthält den Marker und `attach` liefert eine PTY, die Eingaben annimmt

#### Scenario: Reattach trotz fehlendem Arbeitsverzeichnis

- **GIVEN** eine laufende Session, deren `LaunchSpec.cwd` nicht mehr existiert
- **WHEN** `attach` aufgerufen wird
- **THEN** hängt es eine neue PTY an die Session (der Aufruf erfolgt aus `~`)

### Requirement: Cursor im Snapshot

`snapshot` MUST Bildschirm und Cursor in einem tmux-Aufruf abfragen und nach dem Bildschirm `ESC[0m`, `ESC[y+1;x+1H` und `ESC[?25h` liefern, bei von tmux als verborgen gemeldetem Cursor `ESC[?25l`.

#### Scenario: Cursor im Snapshot

- **GIVEN** ein Bildschirm, dessen Cursor bei Spalte 9, Zeile 4 (0-basiert) sichtbar steht
- **WHEN** `snapshot` aufgerufen wird
- **THEN** enden die Daten mit `ESC[0m ESC[5;10H ESC[?25h`

### Requirement: Beenden

`kill` SHALL die tmux-Session beenden und erst auflösen, wenn `has-session` sie nicht mehr findet; bleibt sie länger als die Frist bestehen, MUST `kill` mit einem Fehler ablehnen. Danach MUST `exists` `false` liefern.

#### Scenario: Kill

- **GIVEN** eine laufende Session
- **WHEN** `kill` aufgelöst hat
- **THEN** liefert `exists` `false`

### Requirement: PTY-Ende und Exit-Code

Endet das Programm in der tmux-Session, SHALL die PTY ihr Ende mit dem Exit-Code des Programms melden (bei Ende durch ein Signal `128 + Signal`) und das Backend die tmux-Session danach entfernen. Endet nur der tmux-Client, während die Session weiterlebt, oder lässt sich der Zustand nicht feststellen, MUST das Ende ohne Exit-Code gemeldet werden und die Session bestehen bleiben.

#### Scenario: Programm endet mit Code

- **GIVEN** eine Session mit `command` `sh -c "exit 7"`
- **WHEN** das Programm endet
- **THEN** meldet die PTY `exitCode` 7 und `exists` liefert `false`

#### Scenario: Client geht verloren

- **GIVEN** eine laufende Session
- **WHEN** der tmux-Client von außen getrennt wird
- **THEN** meldet die PTY ein Ende ohne `exitCode` und `exists` liefert `true`

### Requirement: Keepalive je Distro

Solange das Backend mindestens eine Session einer Distro kennt (gestartet, angehängt oder per `exists` gefunden), SHALL je Distro ein Prozess `wsl.exe -d <distro> --cd ~ --exec tmux -L <socket> wait-for termdock-keepalive` ohne PTY laufen, losgelöst vom Core (`detached`), so dass er dessen Ende überlebt. Endet die letzte bekannte Session der Distro (`kill`, Programm-Ende oder `exists` meldet sie als weg), MUST das Backend den Prozess beenden.

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

### Requirement: Keepalive-Neustart und Abbau

Endet ein Keepalive unerwartet, während noch Sessions seiner Distro bekannt sind, SHALL das Backend ihn neu starten, mit exponentiell wachsender Wartezeit (1 s, 2 s, … höchstens 60 s), die nach einer Laufzeit von mehr als 30 s zurückgesetzt wird. Lässt sich der Zustand einer Session nach dem Ende ihres tmux-Clients nicht feststellen, MUST das Backend sie im Keepalive freigeben. Das Schließen MUST je Distro mit bekannten Sessions einen laufenden Keepalive hinterlassen; danach startet keiner mehr.

#### Scenario: Keepalive stirbt

- **GIVEN** eine bekannte Session und ihr Keepalive
- **WHEN** der Keepalive-Prozess unerwartet endet
- **THEN** startet kurz danach ein neuer

#### Scenario: Keepalive scheitert wiederholt

- **GIVEN** ein Keepalive, der sofort nach dem Start endet
- **WHEN** er mehrfach hintereinander neu gestartet wird
- **THEN** verdoppelt sich die Wartezeit bis höchstens 60 s statt dauernd neu zu starten

#### Scenario: Backend schließen

- **GIVEN** laufende Keepalives
- **WHEN** das Backend geschlossen wird
- **THEN** laufen sie weiter, und weder ein Neustart noch eine neue Session startet danach einen Keepalive

#### Scenario: Schließen während ein Neustart wartet

- **GIVEN** eine bekannte Session, deren Keepalive gerade geendet hat (etwa „no server running“), und ein wartender Neustart
- **WHEN** das Backend geschlossen wird
- **THEN** startet es sofort einen Keepalive, und das Schließen ist erst danach fertig

#### Scenario: Schließen während der Übernahme

- **GIVEN** eine bekannte Session und eine laufende Übernahme, deren `pkill` den alten Keepalive schon beendet haben kann
- **WHEN** das Backend geschlossen wird
- **THEN** startet es nach dem Ende der Übernahme genau einen Keepalive, und das Schließen ist erst danach fertig

### Requirement: Verfügbarkeit und Distro

`available` SHALL `true` liefern, wenn die gewählte Distro erreichbar ist und dort `tmux` startet, sonst `false`, ohne zu werfen. Ohne konfigurierte Distro MUST die Standard-Distro von WSL verwendet werden.

#### Scenario: Distro fehlt

- **GIVEN** eine konfigurierte Distro, die es nicht gibt
- **WHEN** `available` aufgerufen wird
- **THEN** liefert es `false`

### Requirement: Neuzeichnen über refresh-client

`redraw` SHALL die tmux-Clients der Session mit `list-clients -t =td-<id> -F '#{client_tty}'` ermitteln und jeden mit `refresh-client -t <tty>` vollständig neu zeichnen lassen, beides ohne PTY und aus `~`. Ein Client-Name, der kein Gerätepfad unter `/dev/` aus Buchstaben, Ziffern, `/`, `_` und `-` ist, MUST verworfen werden. Jeder Client MUST einzeln neu gezeichnet werden; `redraw` MUST nur scheitern, wenn `list-clients` scheitert oder kein Client neu gezeichnet wurde.

#### Scenario: Ein Client ist schon weg

- **GIVEN** `list-clients` meldet `/dev/pts/3` und `/dev/pts/5`, `/dev/pts/3` hat sich inzwischen getrennt
- **WHEN** `redraw` aufgerufen wird
- **THEN** ruft das Backend `refresh-client` auch für `/dev/pts/5` auf und endet ohne Fehler

#### Scenario: Neuzeichnen kommt durch die PTY

- **GIVEN** eine laufende Session, deren Bildschirm einen Marker zeigt
- **WHEN** `redraw` aufgerufen wird
- **THEN** gibt die PTY den ganzen Bildschirm samt Marker erneut aus

#### Scenario: Fremder Client-Name

- **GIVEN** `list-clients` meldet `/dev/pts/3` und `;kill-server`
- **WHEN** `redraw` aufgerufen wird
- **THEN** ruft das Backend `refresh-client` nur für `/dev/pts/3` auf

### Requirement: Distributionen für Clients auflisten

Der Core SHALL `wsl.distros` mit den Distributionen beantworten, die `wsl.exe -l -v` nennt (Argument-Array, `WSL_UTF8=1`, Nullbytes einer UTF-16-Ausgabe entfernt, höchstens 5 s), und der Standard-Distro. Namen, die die Grenzen des Vertrags verletzen, MUST er auslassen, über 64 hinaus abschneiden. Scheitert oder dauert der Aufruf zu lange oder fehlt ein WSL-Backend, SHALL er eine leere Liste mit Grund in `unavailable` liefern, ohne Fehler und ohne Absturz.

#### Scenario: Zwei Distributionen

- **GIVEN** `wsl.exe -l -v` nennt `Ubuntu` (Standard, mit `*`) und `Debian`
- **WHEN** ein Client `wsl.distros` aufruft
- **THEN** erhält er `{ distros: ["Ubuntu", "Debian"], defaultDistro: "Ubuntu" }`

#### Scenario: WSL nicht verfügbar

- **GIVEN** `wsl.exe` endet mit einem Fehler oder antwortet nicht innerhalb von 5 s
- **WHEN** ein Client `wsl.distros` aufruft
- **THEN** erhält er `{ distros: [] }` mit einem Grund in `unavailable`, und der Core beantwortet weitere Anfragen

#### Scenario: Echte Distribution

- **GIVEN** ein Host mit WSL und `TERMDOCK_WSL_TESTS=1`
- **WHEN** das WSL-Backend die Distributionen auflistet
- **THEN** enthält die Liste die Standard-Distro, und kein Name enthält ein Nullbyte

### Requirement: Prüfung des Arbeitsverzeichnisses beim Start

Beim Start einer Session SHALL das WSL-Backend ein absolutes `cwd` (bis 512 Zeichen) mit `wsl.exe -d <distro> --cd ~ --exec test -d <cwd>` als Argument-Array prüfen, parallel zum Statusaufruf des Starts. Fehlt das Verzeichnis, MUST die Session trotzdem starten (die Shell läuft in `/`) und die PTY die Warnung `cwd_missing` mit Pfad und Distro tragen. `~`, `~/…` und andere Formen MUST es nicht prüfen; `attach` prüft nicht.

#### Scenario: Fehlendes Verzeichnis

- **GIVEN** ein `LaunchSpec` mit `cwd` `/srv/api`, das es in der Distro `Ubuntu` nicht gibt
- **WHEN** die Session gestartet wird und in ihr `pwd` läuft
- **THEN** läuft sie, die Ausgabe zeigt `/`, und die PTY trägt `[{ code: "cwd_missing", path: "/srv/api", distro: "Ubuntu" }]`

#### Scenario: Vorhandenes Verzeichnis

- **GIVEN** ein `LaunchSpec` mit `cwd` `/tmp`
- **WHEN** die Session gestartet wird
- **THEN** trägt die PTY keine Warnung

#### Scenario: Pfad wörtlich

- **GIVEN** ein `cwd` `/srv/api; rm -rf ~`
- **WHEN** die Session gestartet wird
- **THEN** ist der Prüfaufruf genau `["-d", "<distro>", "--cd", "~", "--exec", "test", "-d", "/srv/api; rm -rf ~"]`, ohne Shell

#### Scenario: WSL nicht erreichbar oder zu langsam

- **GIVEN** der Prüfaufruf scheitert, wirft, endet mit einer Meldung von wsl.exe oder braucht länger als 5 s
- **WHEN** die Session gestartet wird
- **THEN** startet sie wie bisher und die PTY trägt keine Warnung

#### Scenario: Hängende Prüfung hält den Start höchstens 1 s auf

- **GIVEN** der Statusaufruf ist fertig, der Prüfaufruf antwortet nicht (etwa eine hängende Freigabe unter `/mnt`)
- **WHEN** die Session gestartet wird
- **THEN** wartet der Start höchstens 1 s länger, startet ohne Warnung, und eine spätere Antwort ändert daran nichts

#### Scenario: Keine Prüfung für das Home-Verzeichnis

- **GIVEN** ein `cwd` `~` oder `~/src`
- **WHEN** die Session gestartet wird
- **THEN** ruft das Backend `test -d` nicht auf

#### Scenario: Parallel zum Statusaufruf

- **WHEN** eine Session gestartet wird
- **THEN** laufen Statusaufruf und Prüfung gleichzeitig, nicht nacheinander

#### Scenario: Beitritt zu einer lebenden Session

- **GIVEN** die tmux-Session der ID läuft noch
- **WHEN** `start` ihr beitritt
- **THEN** trägt die PTY keine Warnung

### Requirement: Übernahme verbliebener Keepalives

Bevor ein Backend den ersten Keepalive einer Distro startet, SHALL es die Keepalives seines Sockets in dieser Distro beenden, die ein früherer Core hinterlassen hat (`wsl.exe -d <distro> --cd ~ --exec pkill -x -f "tmux -L <socket> wait-for termdock-keepalive"`, Argument-Array), und erst danach seinen eigenen starten. Scheitert das Beenden, MUST es trotzdem starten. Es SHALL das je Distro nur einmal tun und dabei nie einen eigenen Keepalive treffen.

#### Scenario: Neuer Core nach einem Kill

- **GIVEN** der Keepalive eines hart beendeten Core und dessen tmux-Session
- **WHEN** ein neuer Core startet und die Session beim Abgleich findet
- **THEN** ist der alte Keepalive beendet und genau einer läuft, der des neuen Core

#### Scenario: Kein Leck nach mehreren Neustarts

- **GIVEN** eine WSL-Session
- **WHEN** der Core dreimal nacheinander hart beendet und neu gestartet wird
- **THEN** läuft für ihren Socket genau ein Keepalive

#### Scenario: Übernahme scheitert

- **GIVEN** eine Distro, in der der `pkill`-Aufruf fehlschlägt
- **WHEN** das Backend die erste Session der Distro hält
- **THEN** startet es seinen Keepalive trotzdem

#### Scenario: Session während der Übernahme erneut gehalten

- **GIVEN** eine laufende Übernahme, während der die einzige Session freigegeben und wieder gehalten wird
- **WHEN** die Übernahme endet
- **THEN** startet genau ein Keepalive, und es folgt keine zweite Übernahme
