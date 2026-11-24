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

### Requirement: Existenz vieler Sessions

`listLive` SHALL für viele Sessions mit genau einem `wsl.exe`-Aufruf `tmux -L <socket> list-sessions -F '#{session_name} #{pane_dead}'` je Distro beantworten, welche leben, nach derselben Regel wie `exists` (lebend, solange die aktive Pane nicht als tot gemeldet ist). Ohne tmux-Server MUST es eine leere Menge liefern, bei einem anderen Fehler in einer Distro `undefined`, ohne den Keepalive zu ändern.

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

### Requirement: Keepalive-Neustart und Abbau

Endet ein Keepalive unerwartet, während noch Sessions seiner Distro bekannt sind, SHALL das Backend ihn neu starten, mit wachsender Wartezeit (1 s, 2 s, … höchstens 60 s), die nach einer Laufzeit von mehr als 30 s zurückgesetzt wird. Lässt sich der Zustand einer Session nach dem Ende ihres tmux-Clients nicht feststellen, MUST das Backend sie im Keepalive freigeben. Das Schließen MUST je Distro mit bekannten Sessions einen laufenden Keepalive hinterlassen; danach startet keiner mehr.

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

#### Scenario: Schließen während ein Start läuft

- **GIVEN** ein `start`, dessen PTY gerade gestartet wird
- **WHEN** das Backend geschlossen wird
- **THEN** hinterlässt es für die Session einen laufenden Keepalive, und ein späteres `start` scheitert vor seiner PTY

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

### Requirement: WSL-Integrationstests mit eigenem tmux-Socket

Jede Datei der WSL-Integrationstests (`*.wsl.test.ts`) SHALL einen tmux-Socket `termdock-test-<pid>-<nonce>` für sich allein nutzen, beim Ende ihren Server beenden (`tmux -L <socket> kill-server`, nur für den eigenen Socket) und Server von Sockets beendeter Prozesse aufräumen. Der feste Socket `termdock-test` und der Socket `termdock` MUST unberührt bleiben. Ein Test in der CI MUST sicherstellen, dass keine `*.wsl.test.ts` den festen Namen `termdock-test` enthält.

#### Scenario: Parallele Läufe

- **GIVEN** zwei Worktrees führen die WSL-Integrationstests gleichzeitig aus
- **WHEN** der Test einer Datei seine `td-*`-Sessions aufräumt
- **THEN** beendet er nur Sessions auf seinem Socket, und kein Test des anderen Laufs verliert eine Session

#### Scenario: Aufräumen verwaister Server

- **GIVEN** Sockets `termdock-test-<pid>-<nonce>` eines beendeten und eines laufenden Prozesses sowie `termdock` und `termdock-test`
- **WHEN** ein Testlauf aufräumt
- **THEN** beendet er nur den Server auf dem Socket des beendeten Prozesses

#### Scenario: Fester Socketname

- **GIVEN** die Quellen der `*.wsl.test.ts` in `packages/` und `apps/`
- **WHEN** der Test auf den Namen `termdock-test` als Zeichenkette prüft
- **THEN** findet er keine Datei, die ihn enthält

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

### Requirement: Ende des tmux-Servers

Endet der tmux-Server des Sockets (`kill-server`, Absturz), SHALL jede PTY des Backends ihr Ende ohne Exit-Code melden und `exists` `false` liefern. Danach MUST für diesen Socket kein `wsl.exe`-Prozess des Backends übrig bleiben: keine PTY und kein neu gestarteter Keepalive.

#### Scenario: tmux-Server endet

- **GIVEN** zwei laufende Sessions auf dem Socket eines Tests, je mit PTY, und ihr Keepalive
- **WHEN** `tmux -L <socket> kill-server` läuft
- **THEN** werden beide Sessions `Interrupted`, in WSL läuft kein Prozess mit `-L <socket>` mehr und unter Windows kein `wsl.exe` mit dem Socket in der Befehlszeile, auch nicht 3 s später

### Requirement: Gemeinsamer Leser für die ConPTY-Ausgabe

Der Core SHALL die Ausgabe-Pipes aller PTYs über genau einen Worker-Thread lesen (ADR 0008). Eine PTY MUST erst starten, wenn dieser Worker läuft. Nach der Verbindung von node-pty MUST die Weiterleitung keinen weiteren Client annehmen (davor bleibt ein Wettlauf, ADR 0008). Endet eine PTY, MUST der Worker ihre Pipe schließen, auch ohne `kill`, nachdem ihre letzte Ausgabe angekommen ist. 20 PTYs MUST den RSS um weniger als 60 MiB erhöhen, `kill()` MUST unter voller Ausgabe sofort zurückkehren.

#### Scenario: Viele PTYs

- **GIVEN** ein Core-Prozess mit einer laufenden PTY
- **WHEN** 20 weitere PTYs mit `cmd.exe` starten
- **THEN** laufen alle über denselben Worker-Thread, und der RSS wächst um weniger als 60 MiB

#### Scenario: Beenden unter voller Ausgabe

- **GIVEN** fünf PTYs, deren Programme ohne Pause Zeilen ausgeben
- **WHEN** der Core jede PTY mit `kill()` beendet
- **THEN** kehrt jeder Aufruf in weniger als 1 s zurück, jede PTY meldet ihr Ende genau einmal, und der Worker hält keine Pipe mehr

#### Scenario: Ende ohne kill

- **GIVEN** eine PTY mit `cmd.exe /c echo marker-153`
- **WHEN** das Programm endet
- **THEN** enthält die Ausgabe beim gemeldeten Ende `marker-153`, der Exit-Code ist 0, und der Worker hat die Pipe geschlossen

#### Scenario: Fremder Client an der Weiterleitung

- **GIVEN** eine laufende PTY, deren Ausgabe bei node-pty ankommt
- **WHEN** ein anderer Client sich mit `<pipe>-worker` verbinden will
- **THEN** kommt keine Verbindung zustande

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

Endet der Worker unerwartet oder scheitert die Verbindung einer PTY zur Weiterleitung, SHALL der Core den Prozess jeder betroffenen PTY beenden, je ConPTY höchstens ein `kill`, und ihr Ende genau einmal nach dem Prozessende melden, mit einer Zahl als Exit-Code (ohne Exit-Code nach höchstens 2 s mit -1). Die WSL-Session wird neu angehängt. Zustand, Views und Schreiber MUST bleiben, je Session MUST genau ein tmux-Client laufen. Die nächste PTY MUST einen neuen Worker starten.

#### Scenario: PTYs ohne WSL

- **GIVEN** drei PTYs mit `cmd.exe`
- **WHEN** der Worker abstürzt
- **THEN** melden alle drei ihr Ende genau einmal, jeweils erst nach dem Ende ihres Prozesses und mit einer Zahl als Exit-Code, und eine neue PTY läuft mit einem neuen Worker

#### Scenario: Verbindung zur Weiterleitung scheitert

- **GIVEN** zwei laufende PTYs mit `cmd.exe`
- **WHEN** die Verbindung der ersten zu `<pipe>-worker` mit einem Fehler endet (etwa weil ein anderer Client die Pipe zuerst belegt hat)
- **THEN** stürzt der Core nicht ab, die erste PTY meldet ihr Ende genau einmal nach dem Prozessende mit einer Zahl als Exit-Code, und die zweite läuft weiter

#### Scenario: Zweites kill

- **GIVEN** eine laufende PTY
- **WHEN** der Core `kill()` zweimal aufruft
- **THEN** schließt node-pty die ConPTY genau einmal, und die PTY meldet ihr Ende genau einmal

#### Scenario: WSL-Sessions

- **GIVEN** zwei laufende WSL-Sessions mit je einer schreibenden View
- **WHEN** der Worker abstürzt
- **THEN** hat jede Session einen neuen und nur einen tmux-Client, Eingaben kommen an, beide bleiben `Running` mit ihrem Schreiber, und die Zahl der `wsl.exe`-Prozesse ist dieselbe wie vorher

### Requirement: PTYs enden nacheinander

Der Core SHALL die PTYs eines Prozesses nacheinander schließen. Die nächste schließt er erst, wenn der Prozess der vorigen geendet hat, spätestens nach 2 s. Dann, oder vor der ersten Ausgabe sofort, beendet er den Prozess selbst und wartet noch höchstens 0,5 s. Das gilt für jeden Abbau, auch nach einem Absturz des Lesers. Vor seinem Ende MUST der Core auf alle begonnenen Schließvorgänge warten, höchstens 15 s.

#### Scenario: Abbau mit vielen PTYs

- **GIVEN** eine Registry mit 20 Sessions, deren PTYs `cmd.exe` über den Pfad des Core ausführen
- **WHEN** die Registry abgebaut wird
- **THEN** läuft direkt danach noch jeder Prozess, nach dem Warten auf die Schlange ist jeder beendet, und das dauert weniger als 15 s

#### Scenario: Reproduktion

- **GIVEN** Windows ohne WSL und ein gebauter Core
- **WHEN** `node scripts/pty-shutdown-repro.mjs` 50 Läufe mit je 20 PTYs ausführt
- **THEN** endet jeder Lauf mit Code 0

#### Scenario: PTY vor ihrer ersten Ausgabe

- **GIVEN** eine PTY, die noch nichts ausgegeben hat, sodass node-pty sein `kill` zurückstellt
- **WHEN** der Core sie schließt
- **THEN** ist ihr Prozess nach weniger als 5 s beendet, und die Schlange geht weiter

#### Scenario: Ende des Core wartet

- **GIVEN** ein WSL-Backend, dessen PTYs noch schließen
- **WHEN** es abgebaut wird
- **THEN** endet der Abbau erst, wenn die Schlange leer ist
