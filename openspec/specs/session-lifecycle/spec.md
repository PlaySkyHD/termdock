# session-lifecycle Specification

## Purpose
Legt fest, wie der Core Terminal-Sessions verwaltet: Zustände und erlaubte Übergänge, angehängte Views mit genau einer schreibenden View, Verteilung der Ausgabe und Snapshot-Fallback für neue Views.

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

Beim Anlegen SHALL der Core eine neue Session mit einer UUID als stabiler ID im Zustand `Starting` registrieren und ihren Prozess über das zum `LaunchSpec` passende Backend starten. Nach erfolgreichem Start MUST die Session `Running` sein, wenn mindestens eine View angehängt ist, sonst `Detached`. Schlägt der Start fehl oder fehlt das Backend, MUST die Session `Interrupted` werden und der Aufruf mit `backend_unavailable` fehlschlagen.

#### Scenario: Start ohne View

- **WHEN** eine Session angelegt wird und noch keine View angehängt ist
- **THEN** hat sie eine UUID, das Backend hat genau einen Start erhalten und der Zustand ist `Detached`

#### Scenario: Start schlägt fehl

- **GIVEN** ein Backend, dessen Start fehlschlägt
- **WHEN** eine Session angelegt wird
- **THEN** schlägt der Aufruf mit `backend_unavailable` fehl und die Session ist registriert und `Interrupted`

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

### Requirement: Ausgabeverteilung

Der Core SHALL jede Ausgabe der PTY einer Session genau einmal als Ereignis melden, zusammen mit allen zu diesem Zeitpunkt angehängten Views. Ausgabe ohne angehängte View MUST trotzdem in den Rohdaten-Puffer der Session gehen.

#### Scenario: Ausgabe an zwei Views

- **GIVEN** eine Session mit den Views A und B
- **WHEN** die PTY Daten ausgibt
- **THEN** wird ein Ausgabeereignis mit genau diesen Daten und den Views A und B gemeldet

### Requirement: Snapshot für neue Views

Beim Anhängen SHALL eine View einen Snapshot erhalten. Liefert das Backend einen eigenen Bildschirminhalt, MUST dieser verwendet werden, sonst der Inhalt des Rohdaten-Puffers. Der Puffer MUST auf die letzten 256 KiB Ausgabe je Session begrenzt sein.

#### Scenario: Fallback auf den Puffer

- **GIVEN** ein Backend ohne eigenen Snapshot und eine Session, die 300 KiB ausgegeben hat
- **WHEN** eine View angehängt wird
- **THEN** enthält ihr Snapshot genau die letzten 256 KiB der Ausgabe

#### Scenario: Snapshot des Backends

- **GIVEN** ein Backend, das für die Session einen Bildschirminhalt liefert
- **WHEN** eine View angehängt wird
- **THEN** enthält ihr Snapshot diesen Bildschirminhalt

### Requirement: Ende der PTY

Endet die PTY einer laufenden Session mit Exit-Code, SHALL die Session `Exited` werden und den Exit-Code speichern. Endet sie ohne Exit-Code (Prozess oder tmux-Client unerwartet verloren), MUST die Session `Interrupted` werden. Angehängte Views bleiben angehängt.

#### Scenario: Prozess endet selbst

- **GIVEN** eine laufende Session
- **WHEN** die PTY mit Exit-Code 0 endet
- **THEN** ist die Session `Exited` mit letztem Exit-Code 0

#### Scenario: Unerwartetes PTY-Ende

- **GIVEN** eine Session im Zustand `Running` oder `Detached`
- **WHEN** die PTY ohne Exit-Code endet
- **THEN** ist die Session `Interrupted`

### Requirement: Beenden

`kill` SHALL eine Session in `Running` oder `Detached` über das Backend beenden und sie danach `Exited` setzen, auch wenn die PTY dabei ohne Exit-Code endet.

#### Scenario: Laufende Session beenden

- **GIVEN** eine Session im Zustand `Running`
- **WHEN** sie beendet wird
- **THEN** hat das Backend die Session beendet und der Zustand ist `Exited`

### Requirement: Neustart

`restart` SHALL eine Session in `Exited` oder `Interrupted` unter derselben Session-ID über `Starting` neu starten. Besteht die Backend-Session noch, MUST der Core sich wieder anbinden statt einen zweiten Prozess zu starten. Angehängte Views und der Schreiber bleiben erhalten.

#### Scenario: Neustart nach Prozessende

- **GIVEN** eine Session im Zustand `Exited` mit einer angehängten View
- **WHEN** sie neu gestartet wird
- **THEN** behält sie ihre ID, das Backend hat einen neuen Start erhalten und der Zustand ist `Running`

#### Scenario: Neustart bei noch vorhandener Backend-Session

- **GIVEN** eine `Interrupted`-Session, deren Backend-Session noch existiert
- **WHEN** sie neu gestartet wird
- **THEN** bindet sich der Core wieder an, ohne einen neuen Start auszulösen

### Requirement: Archivieren

`archive` SHALL eine Session in `Running`, `Detached`, `Exited` oder `Interrupted` nach `Archived` bringen. Läuft der Prozess noch oder existiert die Backend-Session noch, MUST er zuerst über das Backend beendet werden. Alle Views werden getrennt. `Archived` ist endgültig.

#### Scenario: Laufende Session archivieren

- **GIVEN** eine Session im Zustand `Running`
- **WHEN** sie archiviert wird
- **THEN** hat das Backend den Prozess beendet, die Session ist `Archived` und hat keine Views und keinen Schreiber

#### Scenario: Neustart einer archivierten Session

- **GIVEN** eine Session im Zustand `Archived`
- **WHEN** sie neu gestartet werden soll
- **THEN** schlägt der Aufruf mit `invalid_state` fehl
