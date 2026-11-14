## MODIFIED Requirements

### Requirement: Schmale Brücke zwischen Renderer und Main

Der Renderer SHALL keinen Zugriff auf die Pipe, auf Node oder auf Electron-Module haben (`contextIsolation`, `sandbox`, kein `nodeIntegration`, CSP ohne Inline-Skripte). Der Main SHALL vom Renderer nur eine feste Liste von Aufrufen annehmen (Core-Status, Sessions auflisten, anlegen, anhängen, lösen, Eingabe, Größe, Schreibrecht, Layout des Fensters lesen und melden), ihre Argumente prüfen und Fehler mit stabilem Code zurückgeben.

#### Scenario: Unbekannter Aufruf

- **WHEN** ein Renderer einen Aufruf außerhalb der Liste sendet, etwa `core.shutdown`
- **THEN** antwortet der Main mit `bad_request` und sendet nichts an den Core

#### Scenario: Fehler des Core

- **WHEN** der Core einen Aufruf mit einem Fehlercode ablehnt, etwa `not_found`
- **THEN** erhält der Renderer denselben Code und die Meldung

#### Scenario: Core-Status

- **WHEN** der Renderer `coreStatus` aufruft
- **THEN** sendet der Main `core.status` und gibt `backendUnavailable` zurück

#### Scenario: Ungültiges Layout gemeldet

- **WHEN** ein Renderer mit `reportLayout` einen Teil meldet, der die Prüfung des Layouts verletzt (etwa fünf Panes in einem Tab, eine doppelte ID oder ein unbekannter Schlüssel)
- **THEN** antwortet der Main mit `bad_request`, und das gespeicherte Layout bleibt unverändert

## ADDED Requirements

### Requirement: Layout gebündelt speichern

Der Main SHALL das Layout aller Fenster zu einem `LayoutDocument` bündeln (Tabs, aktiver Tab und Sidebar je Fenster vom Renderer, Position, Größe und Maximierung aus dem `BrowserWindow`) und mit `layout.save` speichern: nach Änderungen mit kurzer Verzögerung, mehrere Änderungen in einem Aufruf, und beim Beenden sofort. Die letzten Fenster bleiben beim Beenden im Layout; ein vom Benutzer geschlossenes weiteres Fenster wird entfernt.

#### Scenario: Mehrere Änderungen

- **WHEN** innerhalb der Verzögerung drei Änderungen eintreffen
- **THEN** sendet der Main ein `layout.save` mit dem Stand nach der dritten

#### Scenario: Beenden

- **GIVEN** zwei Fenster sind offen
- **WHEN** der Benutzer die App beendet
- **THEN** ist das Layout mit beiden Fenstern gespeichert, bevor die Verbindung zum Core endet

#### Scenario: Revisionskonflikt

- **GIVEN** ein anderer Client hat das Layout gespeichert, `layout.save` mit der bekannten Revision antwortet `invalid_state`
- **WHEN** der Main speichert
- **THEN** lädt er mit `layout.get` die aktuelle Revision und speichert seinen Stand erneut, sodass der letzte Stand gilt

### Requirement: Layout beim Start wiederherstellen

Beim Start SHALL der Main `layout.get` aufrufen und für jedes gespeicherte Fenster ein Fenster mit Tabs, Splits, aktiven Panes und Sidebar öffnen; jedes Pane hängt sich neu an. Position und Größe SHALL gegen `screen.getAllDisplays()` geprüft werden: liegt das Fenster nicht mehr ausreichend auf einem Bildschirm, wird es auf dem primären Bildschirm zentriert und auf dessen Arbeitsfläche begrenzt. Ohne gespeichertes Layout öffnet ein Fenster im Startzustand ohne Tabs.

#### Scenario: Zwei Fenster

- **GIVEN** ein gespeichertes Layout mit zwei Fenstern mit mehreren Tabs und einem Split
- **WHEN** die App startet
- **THEN** öffnen sich zwei Fenster mit denselben Tabs, Panes, Anteilen, aktiven Tabs und aktiven Panes, und jedes Pane einer lebenden Session hängt sich an

#### Scenario: Bildschirm fehlt

- **GIVEN** ein Fenster wurde auf einem Bildschirm gespeichert, der nicht mehr vorhanden ist
- **WHEN** die App startet
- **THEN** liegt das Fenster vollständig im sichtbaren Bereich des primären Bildschirms

#### Scenario: Kein Layout

- **GIVEN** `layout.get` liefert kein Layout
- **WHEN** die App startet
- **THEN** öffnet ein Fenster mit Sidebar und Leerzustand

#### Scenario: Neuladen der Seite

- **GIVEN** ein Fenster mit Tabs, dessen Seite neu lädt
- **WHEN** der Renderer startet
- **THEN** erhält er mit `windowLayout` dieselben Tabs und meldet nichts, bevor er sie übernommen hat

### Requirement: Platzhalter für nicht lebende Sessions

Ein Pane, dessen Session `Exited`, `Interrupted`, `Starting` oder `Archived` ist oder im Core fehlt, SHALL sich nicht anhängen, sondern Zustand, letzten Exit-Code und die Aktion „Pane schließen“ zeigen und nie als `Running` erscheinen. Eine Session gilt erst nach der ersten Session-Liste als fehlend.

#### Scenario: Interrupted nach Neustart

- **GIVEN** ein gespeichertes Pane zeigt eine Session, die der Core als `Interrupted` meldet
- **WHEN** das Layout wiederhergestellt wird
- **THEN** zeigt das Pane „Unterbrochen“ mit Zustand und der Aktion „Pane schließen“, und es gibt kein `session.attach` dafür

#### Scenario: Pane schließen

- **WHEN** der Benutzer im Platzhalter „Pane schließen“ wählt
- **THEN** entfernt der Store das Pane (bei der letzten schließt er den Tab), und das neue Layout wird gespeichert

#### Scenario: Fehlende Session

- **GIVEN** das Layout nennt eine Session, die der Core nicht kennt
- **WHEN** die Session-Liste geladen ist
- **THEN** zeigt das Pane den Platzhalter „Session nicht gefunden“, davor „Sessions werden geladen“

### Requirement: Screenshot-Szenen für die Wiederherstellung

Der Screenshot-Modus SHALL zusätzlich ein Layout mit 2 Fenstern, mehreren Tabs und Splits vor dem Neustart der Oberfläche und den wiederhergestellten Zustand danach aufnehmen und beide Zustände (Tabs, Panes, Anteile, aktive Tabs, Position und Größe) vergleichen, dazu den Platzhalter einer vorher mit `tmux kill-session` beendeten Session. Weicht der Zustand ab, SHALL der Lauf mit Code 1 enden.

#### Scenario: Aufnahme der Wiederherstellung

- **WHEN** die App mit `--screenshot <dir>` startet
- **THEN** enthält `<dir>` zusätzlich PNG-Dateien beider Fenster vor und nach dem Neustart und einen Platzhalter einer `Interrupted`-Session
