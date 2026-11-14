# session-lifecycle Specification

## Purpose
Legt fest, wie der Core Terminal-Sessions verwaltet: Zustände und erlaubte Übergänge, angehängte Views mit genau einer schreibenden View, Verteilung der Ausgabe, Snapshot-Fallback für neue Views, Festhalten der Backend-Vorgaben, Wiederanbinden nach verlorenem Client und Freigeben beim Core-Ende.

## Requirements

### Requirement: Erlaubte Zustandsübergänge

Der Core SHALL für Sessions nur diese Übergänge zulassen: `Starting → Running | Interrupted | Exited`, `Running ↔ Detached`, `Running | Detached → Exited | Interrupted`, `Exited | Interrupted → Starting` und `Exited | Interrupted | Detached | Running → Archived`. Jeder andere Übergang MUST mit dem Fehlercode `invalid_state` abgelehnt werden, ohne den Zustand zu ändern.

#### Scenario: Erlaubter Übergang

- **GIVEN** eine Session im Zustand `Exited`
- **WHEN** der Übergang nach `Starting` geprüft wird
- **THEN** ist er erlaubt

#### Scenario: Verbotener Übergang

- **GIVEN** eine Session im Zustand `Archived`
- **WHEN** ein Übergang in irgendeinen Zustand verlangt wird
- **THEN** schlägt er mit `invalid_state` fehl

#### Scenario: Beenden einer nicht laufenden Session

- **GIVEN** eine Session im Zustand `Exited`
- **WHEN** sie beendet werden soll
- **THEN** schlägt der Aufruf mit `invalid_state` fehl und der Zustand bleibt `Exited`

### Requirement: Anlegen und Starten

Beim Anlegen SHALL der Core eine neue Session mit einer UUID als stabiler ID im Zustand `Starting` registrieren und ihren Prozess über das zum `LaunchSpec` passende Backend starten. Nach erfolgreichem Start MUST die Session `Running` sein, wenn mindestens eine View angehängt ist, sonst `Detached`. Schlägt der Start fehl oder fehlt das Backend, MUST die Session `Interrupted` werden und der Aufruf mit `backend_unavailable` fehlschlagen. Der Fehler MUST die ID der neuen Session nennen.

#### Scenario: Start ohne View

- **WHEN** eine Session angelegt wird und noch keine View angehängt ist
- **THEN** hat sie eine UUID, das Backend hat genau einen Start erhalten und der Zustand ist `Detached`

#### Scenario: Start schlägt fehl

- **GIVEN** ein Backend, dessen Start fehlschlägt
- **WHEN** eine Session angelegt wird
- **THEN** schlägt der Aufruf mit `backend_unavailable` fehl, der Fehler nennt die neue Session-ID und die Session ist registriert und `Interrupted`

### Requirement: Views anhängen und trennen

Der Core SHALL Views einer Session in jedem Zustand außer `Archived` anhängen und trennen. Lebt der Prozess, MUST die erste angehängte View die Session von `Detached` nach `Running` bringen und das Trennen der letzten View sie von `Running` nach `Detached`. Das Trennen einer View MUST den Prozess nicht beenden. Unbekannte Sessions oder Views MUST mit `not_found` abgelehnt werden.

#### Scenario: Erste View hängt sich an

- **GIVEN** eine Session im Zustand `Detached`
- **WHEN** eine View angehängt wird
- **THEN** ist die Session `Running`

#### Scenario: Letzte View trennt sich

- **GIVEN** eine Session im Zustand `Running` mit genau einer View
- **WHEN** diese View getrennt wird
- **THEN** ist die Session `Detached` und der Prozess läuft weiter

#### Scenario: Anhängen an archivierte Session

- **GIVEN** eine Session im Zustand `Archived`
- **WHEN** eine View angehängt werden soll
- **THEN** schlägt der Aufruf mit `invalid_state` fehl

### Requirement: Eingabe-Lock

Pro Session SHALL höchstens eine View Schreiber sein. Eine View, die sich an eine Session ohne andere Views anhängt, MUST Schreiber werden; weitere Views sind lesend. `claimWriter` MUST das Schreibrecht atomar auf die anfragende View übertragen. Trennt sich der Schreiber, MUST keine andere View automatisch Schreiber werden. Jeder Wechsel des Schreibers MUST als Ereignis mit allen Views der Session gemeldet werden.

#### Scenario: Zwei Views

- **GIVEN** eine laufende Session mit View A (zuerst angehängt) und View B
- **WHEN** B Eingabe sendet
- **THEN** wird sie mit `not_writer` abgelehnt und nur Eingaben von A erreichen den Prozess

#### Scenario: Schreibrecht übernehmen bei drei Views

- **GIVEN** eine Session mit den Views A (Schreiber), B und C
- **WHEN** C das Schreibrecht übernimmt
- **THEN** ist C einziger Schreiber, A und B werden mit `not_writer` abgelehnt und ein Schreiberwechsel an A, B und C wird gemeldet

#### Scenario: Schreiber trennt sich

- **GIVEN** eine Session mit den Views A (Schreiber) und B
- **WHEN** A getrennt wird
- **THEN** hat die Session keinen Schreiber, Eingaben von B werden mit `not_writer` abgelehnt und ein Schreiberwechsel ohne Schreiber wird gemeldet

### Requirement: Eingabe nur bei lebendem Prozess

Eingaben des Schreibers SHALL unverändert an die PTY der Session gehen. Lebt kein Prozess (`Starting`, `Exited`, `Interrupted`, `Archived`), MUST eine Eingabe mit `invalid_state` abgelehnt werden.

#### Scenario: Eingabe nach Prozessende

- **GIVEN** eine Session im Zustand `Exited` mit angehängtem Schreiber
- **WHEN** der Schreiber Eingabe sendet
- **THEN** schlägt der Aufruf mit `invalid_state` fehl

### Requirement: Resize-Autorität

Nur der Schreiber SHALL die Terminalgröße einer Session ändern. Der Core MUST die Größe der PTY anpassen, die Größe in der Session speichern und die maßgebliche Größe an alle Views der Session melden. Resize von anderen Views MUST mit `not_writer` abgelehnt werden, Größen mit nicht positiven oder nicht ganzzahligen Werten mit `bad_request`.

#### Scenario: Schreiber ändert die Größe

- **GIVEN** eine laufende Session mit Schreiber A und lesender View B
- **WHEN** A die Größe 120×40 setzt
- **THEN** hat die PTY die Größe 120×40 und A und B erhalten die Meldung der neuen Größe

#### Scenario: Lesende View ändert die Größe

- **GIVEN** eine laufende Session mit Schreiber A und lesender View B
- **WHEN** B eine neue Größe setzt
- **THEN** schlägt der Aufruf mit `not_writer` fehl und die PTY-Größe bleibt unverändert

#### Scenario: Resize während des Starts

- **GIVEN** eine Session im Zustand `Starting` mit Schreiber A
- **WHEN** A eine neue Größe setzt und der Start danach gelingt
- **THEN** hat die neue PTY die von A gesetzte Größe

### Requirement: Ausgabeverteilung

Der Core SHALL jede Ausgabe der PTY einer Session genau einmal als Ereignis melden, zusammen mit allen zu diesem Zeitpunkt angehängten Views. Ausgabe ohne angehängte View MUST trotzdem in den Rohdaten-Puffer der Session gehen.

#### Scenario: Ausgabe an zwei Views

- **GIVEN** eine Session mit den Views A und B
- **WHEN** die PTY Daten ausgibt
- **THEN** wird ein Ausgabeereignis mit genau diesen Daten und den Views A und B gemeldet

### Requirement: Snapshot für neue Views

Beim Anhängen SHALL eine View einen Snapshot erhalten. Liefert das Backend einen eigenen Bildschirminhalt, MUST dieser unverändert hinter den Terminal-Modi der Session verwendet werden, samt Feld `cursor`; Ausgabe, die während der Abfrage eintrifft, MUST NOT angehängt werden. Liefert das Backend nichts oder schlägt die Abfrage fehl, MUST der Inhalt des Rohdaten-Puffers hinter den Terminal-Modi verwendet werden. Der Puffer MUST auf die letzten 256 KiB Ausgabe je Session begrenzt sein.

#### Scenario: Fallback auf den Puffer

- **GIVEN** ein Backend ohne eigenen Snapshot und eine Session, die 300 KiB ausgegeben hat
- **WHEN** eine View angehängt wird
- **THEN** enthält ihr Snapshot genau die letzten 256 KiB der Ausgabe

#### Scenario: Snapshot des Backends

- **GIVEN** ein Backend, das für die Session einen Bildschirminhalt mit Cursor liefert
- **WHEN** eine View angehängt wird
- **THEN** enthält ihr Snapshot diese Daten und das Feld `cursor`

#### Scenario: Ausgabe während der Snapshot-Abfrage

- **GIVEN** ein Backend, das Bildschirminhalt mit Cursorposition liefert
- **WHEN** während der Abfrage weitere Ausgabe eintrifft
- **THEN** enthält der Snapshot nur den Bildschirminhalt mit dem Feld `cursor`, und die neue View erhält diese Ausgabe nicht

#### Scenario: Snapshot-Abfrage schlägt fehl

- **GIVEN** ein Backend, dessen Snapshot-Abfrage fehlschlägt
- **WHEN** eine View angehängt wird
- **THEN** gelingt das Anhängen und der Snapshot enthält den Rohdaten-Puffer

### Requirement: Ende der PTY

Endet die PTY einer laufenden Session mit Exit-Code, SHALL die Session `Exited` werden und den Exit-Code speichern. Endet sie ohne Exit-Code und existiert die Backend-Session nicht mehr oder scheitert das Wiederanbinden, MUST die Session `Interrupted` werden. Angehängte Views bleiben angehängt.

#### Scenario: Prozess endet selbst

- **GIVEN** eine laufende Session
- **WHEN** die PTY mit Exit-Code 0 endet
- **THEN** ist die Session `Exited` mit letztem Exit-Code 0

#### Scenario: Unerwartetes PTY-Ende

- **GIVEN** eine Session im Zustand `Running` oder `Detached`, deren Backend-Session nicht mehr existiert
- **WHEN** die PTY ohne Exit-Code endet
- **THEN** ist die Session `Interrupted`

### Requirement: Beenden

`kill` SHALL eine Session in `Running` oder `Detached` über das Backend beenden und sie danach `Exited` setzen, auch wenn die PTY dabei ohne Exit-Code endet. Schlägt das Beenden im Backend fehl, MUST der Aufruf mit `backend_unavailable` fehlschlagen. Ist die PTY dann schon beendet, MUST die Session `Exited` (Exit-Code bekannt) oder `Interrupted` werden und nie ohne PTY in `Running` oder `Detached` bleiben. Das gilt auch für `archive`.

#### Scenario: Laufende Session beenden

- **GIVEN** eine Session im Zustand `Running`
- **WHEN** sie beendet wird
- **THEN** hat das Backend die Session beendet und der Zustand ist `Exited`

#### Scenario: Backend scheitert nach PTY-Ende

- **GIVEN** eine laufende Session, deren PTY beim Beenden ohne Exit-Code endet, während das Backend einen Fehler meldet
- **WHEN** sie beendet wird
- **THEN** schlägt der Aufruf mit `backend_unavailable` fehl, die Session ist `Interrupted` und lässt sich neu starten

### Requirement: Neustart

`restart` SHALL eine Session in `Exited` oder `Interrupted` unter derselben Session-ID über `Starting` neu starten. Besteht die Backend-Session noch, MUST der Core sich wieder anbinden statt einen zweiten Prozess zu starten. Angehängte Views und der Schreiber bleiben erhalten. Der Rohdaten-Puffer MUST erst geleert werden, wenn die neue PTY angebunden ist.

#### Scenario: Neustart schlägt fehl

- **GIVEN** eine `Exited`-Session mit bisheriger Ausgabe und ein Backend, dessen Start fehlschlägt
- **WHEN** sie neu gestartet wird und danach eine View angehängt wird
- **THEN** ist die Session `Interrupted` und der Snapshot der View enthält die bisherige Ausgabe

#### Scenario: Neustart nach Prozessende

- **GIVEN** eine Session im Zustand `Exited` mit einer angehängten View
- **WHEN** sie neu gestartet wird
- **THEN** behält sie ihre ID, das Backend hat einen neuen Start erhalten und der Zustand ist `Running`

#### Scenario: Neustart bei noch vorhandener Backend-Session

- **GIVEN** eine `Interrupted`-Session, deren Backend-Session noch existiert
- **WHEN** sie neu gestartet wird
- **THEN** bindet sich der Core wieder an, ohne einen neuen Start auszulösen

### Requirement: Archivieren

`archive` SHALL eine Session in `Running`, `Detached`, `Exited` oder `Interrupted` nach `Archived` bringen. Läuft der Prozess noch oder existiert die Backend-Session noch, MUST er zuerst über das Backend beendet werden. Scheitert die Existenzprüfung oder das Beenden im Backend, MUST der Aufruf mit `backend_unavailable` fehlschlagen und die Session nicht `Archived` werden. Alle Views werden getrennt. `Archived` ist endgültig.

#### Scenario: Existenzprüfung scheitert

- **GIVEN** eine `Interrupted`-Session und ein Backend, dessen Existenzprüfung fehlschlägt
- **WHEN** sie archiviert wird
- **THEN** schlägt der Aufruf mit `backend_unavailable` fehl und die Session bleibt `Interrupted`

#### Scenario: Laufende Session archivieren

- **GIVEN** eine Session im Zustand `Running`
- **WHEN** sie archiviert wird
- **THEN** hat das Backend den Prozess beendet, die Session ist `Archived` und hat keine Views und keinen Schreiber

#### Scenario: Neustart einer archivierten Session

- **GIVEN** eine Session im Zustand `Archived`
- **WHEN** sie neu gestartet werden soll
- **THEN** schlägt der Aufruf mit `invalid_state` fehl

### Requirement: Backend-Vorgaben beim Start festhalten

Vor dem Start oder Neustart einer Session SHALL der Core fehlende Vorgaben des `LaunchSpec` vom Backend auflösen lassen (WSL: konfigurierte oder Standard-Distro) und den aufgelösten `LaunchSpec` speichern, bevor er das Backend startet. Alle weiteren Backend-Aufrufe der Session MUST ihn verwenden. Scheitert das Auflösen, gilt der Start als gescheitert.

#### Scenario: Distro fehlt beim Anlegen

- **GIVEN** ein WSL-Backend mit Standard-Distro `Ubuntu`
- **WHEN** eine Session ohne `distro` angelegt wird
- **THEN** hat das Backend den Start mit `distro` `Ubuntu` erhalten und der gespeicherte `LaunchSpec` nennt `Ubuntu`

#### Scenario: Auflösen scheitert

- **GIVEN** ein Backend, dessen Auflösen fehlschlägt
- **WHEN** eine Session angelegt wird
- **THEN** schlägt der Aufruf mit `backend_unavailable` fehl, die Session ist `Interrupted` und das Backend hat keinen Start erhalten

### Requirement: Wiederanbinden nach verlorenem Client

Endet die PTY einer Session in `Running` oder `Detached` ohne Exit-Code, SHALL der Core prüfen, ob die Backend-Session noch existiert, und eine neue PTY anhängen; Zustand, Views und Schreiber MUST erhalten bleiben. Scheitert das, MUST er es nach Wartezeiten erneut versuchen, höchstens dreimal; ein kurz nach dem Anhängen wieder verlorener Client zählt zu denselben Versuchen. Start, Neustart und Abgleich MUST das volle Budget zurückgeben.

#### Scenario: Client geht verloren, Session lebt

- **GIVEN** eine Session in `Running` mit Schreiber A, deren Backend-Session weiterlebt
- **WHEN** die PTY ohne Exit-Code endet
- **THEN** hat der Core sich neu angehängt, die Session ist `Running`, A ist Schreiber und Eingaben von A erreichen die neue PTY

#### Scenario: Anhängen scheitert vorübergehend

- **GIVEN** eine Session in `Detached`, deren Backend-Session weiterlebt, und ein Backend, dessen nächstes Anhängen fehlschlägt
- **WHEN** die PTY ohne Exit-Code endet
- **THEN** gelingt der zweite Versuch und die Session ist `Detached`

#### Scenario: Client geht immer wieder verloren

- **GIVEN** eine Session, deren neu angehängte PTY jedes Mal sofort ohne Exit-Code endet
- **WHEN** die PTY ohne Exit-Code endet
- **THEN** ist die Session nach drei Versuchen `Interrupted`

#### Scenario: Neustart gibt das Budget zurück

- **GIVEN** eine Session, die nach drei verbrauchten Versuchen `Interrupted` wurde und danach neu gestartet ist
- **WHEN** ihre PTY ohne Exit-Code endet
- **THEN** hängt der Core sich erneut an und die Session ist `Detached`

### Requirement: Arbeit während des Wiederanbindens

Solange der Core eine Session wieder anbindet, MUST er `restart` mit `invalid_state` ablehnen. `kill` und `archive` MUST das Wiederanbinden abbrechen, eine laufende Backend-Abfrage abwarten und die Backend-Session beenden. Views SHALL sich weiter anhängen und trennen können; nach dem Anhängen der neuen PTY MUST der Zustand `Running` sein, wenn Views angehängt sind, sonst `Detached`.

#### Scenario: Letzte View trennt sich während des Wiederanbindens

- **GIVEN** eine Session in `Running` mit einer View, deren PTY ohne Exit-Code endete und deren neues Anhängen noch läuft
- **WHEN** die View getrennt wird und das Anhängen danach gelingt
- **THEN** ist die Session `Detached`

#### Scenario: Beenden während des Wiederanbindens

- **GIVEN** eine Session, deren PTY ohne Exit-Code endete und deren Wiederanbinden noch läuft
- **WHEN** `kill` aufgerufen wird
- **THEN** hat das Backend die Session beendet, keine neue PTY wurde angehängt und die Session ist `Exited`

### Requirement: Registry freigeben

Beim Beenden des Core ohne Stop SHALL die Registry alle PTYs lösen, ohne Zustände zu ändern, zu speichern oder Ereignisse zu melden. Laufende Starts, Wiederanbindungen und der Abgleich MUST danach nichts mehr ändern oder speichern; eine danach noch gelieferte PTY MUST sofort gelöst werden.

#### Scenario: Freigeben mit laufender Session

- **GIVEN** eine Session in `Running`
- **WHEN** die Registry freigegeben wird
- **THEN** ist ihre PTY gelöst, das Backend hat die Session nicht beendet und der gespeicherte Zustand ist `Running`

#### Scenario: Start scheitert nach dem Freigeben

- **GIVEN** eine Session, deren Start noch läuft
- **WHEN** die Registry freigegeben wird und der Start danach scheitert
- **THEN** schlägt der Aufruf mit `invalid_state` fehl, kein Ereignis wurde gemeldet und der gespeicherte Zustand ist `Starting`

### Requirement: Grenze zwischen Snapshot und Live-Ausgabe

Der Core SHALL die Ausgabe jeder Session fortlaufend ab 1 nummerieren und jedes Ausgabeereignis mit seiner Nummer melden. Beim Anhängen SHALL er als Marke die Nummer der letzten Ausgabe vor dem Registrieren der View liefern (0 ohne Ausgabe). Die View MUST genau die Ausgabe mit höherer Nummer erhalten; die Nummern MUST über einen Wechsel der PTY hinweg weiterlaufen.

#### Scenario: Marke beim Anhängen

- **GIVEN** eine Session, deren PTY dreimal Daten ausgegeben hat, und eine angehängte View A
- **WHEN** View B angehängt wird und die PTY danach Daten ausgibt
- **THEN** liefert das Anhängen die Marke 3, und das nächste Ausgabeereignis trägt die Nummer 4 und nennt A und B

#### Scenario: Ausgabe während der Abfrage liegt unter der Marke

- **GIVEN** eine View B, deren Backend-Snapshot noch abgefragt wird
- **WHEN** die PTY in dieser Zeit Daten ausgibt
- **THEN** nennt dieses Ausgabeereignis B nicht, und seine Nummer ist höchstens die Marke von B

### Requirement: Neuzeichnen nach dem Anhängen

Stammt der Snapshot einer neuen View vom Backend, SHALL der Core das Backend nach dem Registrieren der View auffordern, den ganzen Bildschirm neu in die PTY zu zeichnen, damit Ausgabe, die der Snapshot schon enthält oder die zwischen Snapshot und Registrieren verloren ging, überschrieben wird. Scheitert das Neuzeichnen oder kann das Backend es nicht, MUST das Anhängen trotzdem gelingen.

#### Scenario: Neuzeichnen nach Backend-Snapshot

- **GIVEN** ein Backend, das für die Session einen Bildschirminhalt liefert
- **WHEN** eine View angehängt wird
- **THEN** fordert der Core das Neuzeichnen erst an, nachdem die View registriert ist

#### Scenario: Kein Neuzeichnen beim Rohdaten-Puffer

- **GIVEN** ein Backend ohne eigenen Snapshot
- **WHEN** eine View angehängt wird
- **THEN** fordert der Core kein Neuzeichnen an

#### Scenario: Neuzeichnen scheitert

- **GIVEN** ein Backend, dessen Neuzeichnen fehlschlägt
- **WHEN** eine View angehängt wird
- **THEN** gelingt das Anhängen mit dem Snapshot des Backends

### Requirement: Neuzeichnen je Session gebündelt und wiederholt

Je Session SHALL höchstens ein Neuzeichnen laufen. Anforderungen, während eines läuft, SHALL der Core zu genau einem weiteren Neuzeichnen danach zusammenfassen. Scheitert ein Neuzeichnen, SHALL der Core es einmal wiederholen und ein erneutes Scheitern im Fehlerprotokoll des Core melden.

#### Scenario: Mehrere Views kurz nacheinander

- **GIVEN** ein Backend mit eigenem Snapshot, dessen Neuzeichnen noch läuft
- **WHEN** drei weitere Views derselben Session angehängt werden
- **THEN** zeichnet das Backend danach genau einmal neu, insgesamt zweimal

#### Scenario: Wiederholung

- **GIVEN** ein Backend, dessen erstes Neuzeichnen fehlschlägt
- **WHEN** eine View angehängt wird
- **THEN** zeichnet der Core ein zweites Mal neu und meldet keinen Fehler; scheitert auch das, meldet er den Fehler einmal

### Requirement: Terminal-Modi im Snapshot

Der Core SHALL in der Ausgabe jeder Session diese Modi verfolgen: Application Cursor Keys, Application Keypad, Mausberichte (Protokoll und Kodierung), Fokusberichte und Bracketed Paste. Der Snapshot einer neuen View MUST mit den Sequenzen beginnen, die genau die eingeschalteten Modi nach der Ausgabe bis `outputSeq` herstellen; ohne eingeschalteten Modus MUST er ohne Präfix beginnen. Ein Neustart MUST die Modi zurücksetzen.

#### Scenario: Späte View erhält die Modi

- **GIVEN** eine Session, deren PTY `ESC[?1h`, `ESC=`, `ESC[?1006h`, `ESC[?1000h`, `ESC[?1002h` und `ESC[?2004h` ausgegeben hat, und ein Backend mit Bildschirminhalt `screen`
- **WHEN** eine View angehängt wird
- **THEN** beginnt ihr Snapshot mit `ESC[?1h`, `ESC=`, `ESC[?1002h`, `ESC[?1006h` und `ESC[?2004h`, gefolgt von `screen`

#### Scenario: Ausgeschaltete Modi

- **GIVEN** eine Session, deren PTY Mausberichte und Bracketed Paste ein- und wieder ausgeschaltet hat
- **WHEN** eine View angehängt wird
- **THEN** enthält ihr Snapshot keine Sequenz für diese Modi

#### Scenario: Sequenz über zwei Ausgaben verteilt

- **GIVEN** eine Session, deren PTY `ESC[?20` und danach `04h` ausgibt
- **WHEN** eine View angehängt wird
- **THEN** beginnt ihr Snapshot mit `ESC[?2004h`

#### Scenario: Modi nach Neustart

- **GIVEN** eine beendete Session, deren PTY Bracketed Paste eingeschaltet hatte
- **WHEN** sie neu gestartet wird und eine View anhängt, bevor die neue PTY Modi setzt
- **THEN** enthält der Snapshot keine Sequenz für Bracketed Paste

#### Scenario: Zweite View einer tmux-Session mit Maus und TUI

- **GIVEN** eine WSL-Session mit `set -g mouse on`, in der `less` läuft, und eine View A, die vor dem Einschalten der Maus angehängt hat und als Schreiber die Größe bestimmt
- **WHEN** eine lesende View B später anhängt
- **THEN** haben A und B dieselben Modi: Mausberichte, Application Cursor Keys, Application Keypad und Bracketed Paste sind eingeschaltet
