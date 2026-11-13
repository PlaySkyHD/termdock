# desktop-shell Specification

## Purpose
Die Desktop-App ist ein Client des Core: Ein Electron-Main verbindet sich mit dem Core oder startet ihn, vermittelt zwischen Renderer und Pipe und zeigt Sessions in Terminal-Views, in denen genau eine View schreibt.

## Requirements

### Requirement: Ein Main-Prozess für alle Fenster

Die Desktop-App SHALL je Windows-Benutzer genau einen Electron-Main-Prozess haben, dem alle Fenster gehören. Ein weiterer Start der App SHALL sich beenden und im laufenden Main ein neues Fenster öffnen.

#### Scenario: Zweiter Start öffnet ein Fenster im laufenden Main

- **GIVEN** die App läuft mit einem Fenster
- **WHEN** der Benutzer die App erneut startet
- **THEN** beendet sich der neue Prozess, und der laufende Main öffnet ein zweites Fenster mit derselben Core-Verbindung

### Requirement: Verbinden vor Starten des Core

Der Main SHALL beim Start zuerst die Pipe des Core verbinden. Nur wenn die Pipe nicht existiert, SHALL er den Core als losgelösten Kindprozess starten (Electron als Node, eigene Prozessgruppe) und erneut verbinden, mit wachsenden Wartezeiten und höchstens 5 s Gesamtzeit ab dem Start des Core.

#### Scenario: Core läuft schon

- **GIVEN** ein Core belegt die Pipe
- **WHEN** die App startet
- **THEN** verbindet sie sich und startet keinen weiteren Core

#### Scenario: Core läuft nicht

- **GIVEN** kein Core belegt die Pipe
- **WHEN** die App startet
- **THEN** startet sie genau einen Core als losgelösten Prozess und verbindet sich, sobald er die Pipe belegt hat

#### Scenario: Core wird nicht erreichbar

- **GIVEN** der gestartete Core belegt die Pipe auch nach 5 s nicht
- **WHEN** die Wiederholungen ausgeschöpft sind
- **THEN** meldet die App den Fehler mit dem letzten Verbindungsfehler und versucht keinen weiteren Start

#### Scenario: Anderer Verbindungsfehler

- **GIVEN** ein Core belegt die Pipe, spricht aber eine andere Hauptversion des Protokolls oder verweigert den Zugriff
- **WHEN** die App startet
- **THEN** meldet sie diesen Fehler und startet keinen Core

#### Scenario: UI schließen, Sessions behalten

- **GIVEN** die App hat den Core gestartet
- **WHEN** der Benutzer alle Fenster schließt
- **THEN** endet der Main, der Core und seine Sessions laufen weiter

### Requirement: Warten auf den Abgleich beim Start

Nach `hello` SHALL der Main mit einer ersten Anfrage auf das Ende des Abgleichs im Core warten und ihr einen großzügigen Timeout (60 s) geben. `session.create` und `session.attach` SHALL er ebenfalls 60 s geben, weil sie auf WSL warten können; alle übrigen Anfragen SHALL er mit dem normalen Timeout (10 s) begrenzen.

#### Scenario: Kalter WSL-Start

- **GIVEN** WSL läuft noch nicht, und das Anlegen der Session dauert 30 s
- **WHEN** die View eine Session anlegt
- **THEN** wartet der Main auf die Antwort, und es entsteht genau eine Session

#### Scenario: Langer Abgleich

- **GIVEN** der Core braucht 20 s für den Abgleich nach seinem Start
- **WHEN** die App sich verbindet
- **THEN** wartet sie, ohne mit `timeout` abzubrechen, und zeigt danach die Session

#### Scenario: Späte Anfrage hängt

- **GIVEN** die Verbindung ist bereit
- **WHEN** der Core eine spätere Anfrage nicht innerhalb von 10 s beantwortet
- **THEN** scheitert sie mit dem Code `timeout`

### Requirement: Schmale Brücke zwischen Renderer und Main

Der Renderer SHALL keinen Zugriff auf die Pipe, auf Node oder auf Electron-Module haben (`contextIsolation`, `sandbox`, kein `nodeIntegration`, CSP ohne Inline-Skripte). Der Main SHALL vom Renderer nur eine feste Liste von Aufrufen annehmen (Sessions auflisten, anlegen, anhängen, lösen, Eingabe, Größe, Schreibrecht), ihre Argumente prüfen und Fehler mit stabilem Code zurückgeben.

#### Scenario: Unbekannter Aufruf

- **WHEN** ein Renderer einen Aufruf außerhalb der Liste sendet, etwa `core.shutdown`
- **THEN** antwortet der Main mit `bad_request` und sendet nichts an den Core

#### Scenario: Fehler des Core

- **WHEN** der Core einen Aufruf mit einem Fehlercode ablehnt, etwa `not_found`
- **THEN** erhält der Renderer denselben Code und die Meldung

### Requirement: Views gehören ihrem Fenster

Eine View SHALL dem Fenster gehören, das sie angehängt hat. Eingabe, Größe, Schreibrecht und Lösen SHALL der Main nur für Views des aufrufenden Fensters weitergeben. Schließt ein Fenster, lädt sein Renderer neu oder stürzt er ab, SHALL der Main dessen Views beim Core lösen.

#### Scenario: Renderer lädt neu

- **GIVEN** Fenster A hat die schreibende View `v1`
- **WHEN** der Renderer von A neu lädt oder abstürzt
- **THEN** sendet der Main `session.detach` für `v1`, und die neue Seite in A hängt sich mit einer neuen View an

#### Scenario: Fremde View

- **GIVEN** Fenster A hat die View `v1`
- **WHEN** Fenster B Eingabe für `v1` sendet
- **THEN** antwortet der Main mit `not_found` und sendet nichts an den Core

#### Scenario: Fenster schließt

- **GIVEN** Fenster A hat die View `v1`
- **WHEN** Fenster A geschlossen wird
- **THEN** sendet der Main `session.detach` für `v1`, und die Session läuft weiter

### Requirement: Events nur an beteiligte Fenster

Der Main SHALL Ausgabe, Größenänderung und Schreiberwechsel einer Session nur an Fenster senden, die eine View dieser Session haben oder gerade eine anhängen, je Fenster einmal. Zustandswechsel von Sessions SHALL er an alle Fenster senden.

#### Scenario: Ausgabe einer Session

- **GIVEN** Fenster A zeigt Session `s1`, Fenster B zeigt Session `s2`
- **WHEN** der Core Ausgabe von `s1` meldet
- **THEN** erhält nur Fenster A die Bytes

#### Scenario: Ausgabe während des Anhängens

- **GIVEN** Fenster A hängt gerade eine View an `s1` an
- **WHEN** der Core direkt nach der Antwort Ausgabe von `s1` meldet
- **THEN** erhält Fenster A die Bytes mit ihrer Sequenznummer, und die View stellt sie nur dar, wenn der Snapshot sie nicht schon enthält

### Requirement: Session beim Start der View

Beim Start SHALL die Terminal-View die Sessions auflisten und die erste lebende Session (`Running` oder `Detached`) anzeigen. Gibt es keine, SHALL sie eine WSL-Session in `~` der Standard-Distro anlegen und diese anzeigen.

#### Scenario: Keine Session

- **GIVEN** der Core kennt keine lebende Session
- **WHEN** die View startet
- **THEN** legt sie eine WSL-Session mit Arbeitsverzeichnis `~` an und hängt sich an

#### Scenario: Lebende Session vorhanden

- **GIVEN** der Core kennt eine `Exited`- und eine `Detached`-Session
- **WHEN** die View startet
- **THEN** hängt sie sich an die `Detached`-Session an und legt keine neue an

### Requirement: Snapshot vor Live-Ausgabe

Nach `session.attach` SHALL die View das Terminal auf die gemeldete Sitzungsgröße bringen, zuerst den Snapshot aus der Antwort darstellen und danach die Live-Ausgabe in Eingangsreihenfolge, auch wenn Ausgabe vor der Antwort eintrifft. Leerzeilen am Ende des Snapshots SHALL sie weglassen, damit der Cursor hinter dem zuletzt geschriebenen Text steht. Ausgabe, deren Sequenznummer nicht über der Marke der Attach-Antwort liegt, SHALL sie verwerfen.

#### Scenario: Ausgabe schon im Snapshot

- **GIVEN** die Attach-Antwort meldet die Marke 5
- **WHEN** Ausgabe mit den Nummern 4, 5 und 6 eintrifft, vor oder nach der Antwort
- **THEN** stellt die View nur die Ausgabe mit Nummer 6 nach dem Snapshot dar

#### Scenario: Snapshot einer Shell

- **GIVEN** die Session ist 117×35 groß und zeigt oben einen Prompt, darunter leere Zeilen
- **WHEN** eine neue View sich anhängt
- **THEN** zeigt sie den Prompt oben in einem Terminal von 117×35, und der Cursor steht hinter dem Prompt

#### Scenario: Ausgabe vor der Antwort

- **GIVEN** die View hat `session.attach` gesendet
- **WHEN** Ausgabe eintrifft, bevor die Antwort mit dem Snapshot da ist
- **THEN** stellt die View zuerst den Snapshot und danach diese Ausgabe dar

### Requirement: Schreiber bestimmt Eingabe und Größe

Nur die schreibende View SHALL Eingaben und ihre eigene Größe an den Core senden; sie passt das Terminal an ihre Fläche an. Eine lesende View SHALL alle Eingaben und automatischen Antworten des Terminals (etwa DA1, Cursorposition) verwerfen und das Terminal in der Größe des Schreibers darstellen, beschnitten, wenn ihre Fläche kleiner ist.

#### Scenario: Schreiber tippt

- **GIVEN** die View schreibt
- **WHEN** der Benutzer `ls --color` und Enter tippt
- **THEN** sendet die View die Bytes mit `session.input`, und die Ausgabe erscheint in allen Views der Session

#### Scenario: Leser beantwortet keine Abfrage

- **GIVEN** die View liest
- **WHEN** das Programm eine Terminal-Abfrage ausgibt und xterm.js eine Antwort erzeugt
- **THEN** sendet die View nichts an den Core

#### Scenario: Schreiber ändert die Größe

- **GIVEN** zwei Views zeigen dieselbe Session, A schreibt
- **WHEN** das Fenster von A kleiner wird
- **THEN** sendet A `session.resize` mit der neuen Größe, und B stellt nach `session.resized` das Terminal in dieser Größe dar

### Requirement: Schreibrecht übernehmen

Eine lesende View SHALL ihre Rolle anzeigen und eine Schaltfläche „Schreibrecht übernehmen“ anbieten. Ein Klick SHALL `session.claimWriter` senden; nach `view.writerChanged` SHALL jede View ihre Rolle aus dem gemeldeten Schreiber ableiten.

#### Scenario: Leser übernimmt

- **GIVEN** A schreibt und B liest dieselbe Session
- **WHEN** der Benutzer in B auf „Schreibrecht übernehmen“ klickt
- **THEN** schreibt B, passt die Größe an ihre Fläche an und sendet sie, und A wird Leser und verwirft ab dann Eingaben

#### Scenario: Schreiber löst sich

- **GIVEN** A schreibt und B liest
- **WHEN** A geschlossen wird
- **THEN** meldet der Core keinen Schreiber, B bleibt Leser und bietet die Übernahme an

#### Scenario: Übernahme abgelehnt

- **WHEN** der Main oder der Core `session.claimWriter` ablehnt
- **THEN** bleibt die View Leser und zeigt die Fehlermeldung in der Statusleiste

#### Scenario: Core-Verbindung endet

- **GIVEN** die View schreibt
- **WHEN** die Verbindung zum Core endet
- **THEN** zeigt die View „Verbindung zum Core getrennt“ und sendet ab dann weder Eingabe noch Größe noch Schreibrecht, auch nach späteren Events

### Requirement: Screenshot-Modus gegen isolierten Core

Mit `--screenshot <dir>` SHALL die App einen eigenen Core starten (eigene Pipe, Datenverzeichnis in einem Temp-Verzeichnis, tmux-Socket `termdock-test`), ein schreibendes und ein lesendes Fenster öffnen, jedes nach dem Darstellen per `capturePage()` als PNG in `<dir>` speichern, danach alle Sessions dieses Core und den Core beenden, das Datenverzeichnis entfernen und sich mit Code 0 beenden; bei einem Fehler mit Code 1.

#### Scenario: Aufnahme

- **WHEN** die App mit `--screenshot <dir>` startet
- **THEN** zeigen beide Fenster eine WSL-Shell mit Prompt und der Ausgabe von `ls --color`, das kleinere Fenster als Leser mit „Schreibrecht übernehmen“, `<dir>` enthält je Fenster eine PNG-Datei, und auf dem Socket `termdock-test` bleibt keine Session dieses Laufs

#### Scenario: Verbindung zum isolierten Core scheitert

- **GIVEN** der Screenshot-Lauf hat seinen Core gestartet
- **WHEN** das Verbinden oder die erste Antwort scheitert
- **THEN** beendet die App diesen Core mit `core.shutdown { stopSessions: true }` oder, wenn er nicht antwortet, über seine Prozess-ID, wartet auf sein Ende, entfernt danach das Datenverzeichnis und endet mit Code 1

#### Scenario: Produktiver Core bleibt unberührt

- **GIVEN** ein produktiver Core und eine App laufen
- **WHEN** die App zusätzlich mit `--screenshot <dir>` gestartet wird
- **THEN** verbindet sie sich nicht mit dem produktiven Core, öffnet kein Fenster im laufenden Main und ändert keine Session auf dem Socket `termdock`
