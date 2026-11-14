## MODIFIED Requirements

### Requirement: Schmale Brücke zwischen Renderer und Main

Der Renderer SHALL keinen Zugriff auf die Pipe, auf Node oder auf Electron-Module haben (`contextIsolation`, `sandbox`, kein `nodeIntegration`, CSP ohne Inline-Skripte). Der Main SHALL vom Renderer nur eine feste Liste von Aufrufen annehmen (Core-Status, Sessions auflisten, anlegen, anhängen, lösen, Eingabe, Größe, Schreibrecht, Layout des Fensters lesen und melden, Antwort auf den Schließen-Dialog), ihre Argumente prüfen und Fehler mit stabilem Code zurückgeben.

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

#### Scenario: Ungültige Antwort auf den Schließen-Dialog

- **WHEN** ein Renderer `answerQuit` mit einer unbekannten Wahl, ohne boolesches `remember` oder mit einer ID sendet, die nicht gefragt wurde
- **THEN** antwortet der Main mit `bad_request` bzw. `not_found`, und das Beenden ändert sich nicht

## ADDED Requirements

### Requirement: Schließen-Dialog bei laufenden Sessions

Beim Beenden durch den Benutzer (Menü, Strg+Q, Schließen des letzten Fensters) SHALL der Main die Sessions mit `session.list` zählen und nur fragen, wenn mindestens eine `Running` oder `Detached` ist und `confirmQuitWhileRunning` gilt. Der Dialog SHALL im fokussierten Fenster erscheinen: „Oberfläche schließen, Sessions behalten“, „Sessions beenden“, „Abbrechen“ und „Nicht mehr fragen“. „Sessions beenden“ SHALL nach dem Speichern des Layouts `core.shutdown { stopSessions: true }` senden.

#### Scenario: Keine laufende Session

- **GIVEN** alle Sessions sind `Exited` oder `Interrupted`, oder es gibt keine
- **WHEN** der Benutzer die App beendet
- **THEN** erscheint kein Dialog, und die App beendet sich wie bisher

#### Scenario: Dialog bei laufenden Sessions

- **GIVEN** eine Session ist `Running` oder `Detached`, und die Nachfrage ist an
- **WHEN** der Benutzer die App beendet
- **THEN** bleibt die App offen und zeigt den Dialog mit der Zahl der laufenden Sessions; der Fokus liegt auf „Oberfläche schließen, Sessions behalten“

#### Scenario: Abbrechen

- **GIVEN** der Dialog ist offen und „Nicht mehr fragen“ ist gesetzt
- **WHEN** der Benutzer „Abbrechen“ wählt oder Escape drückt
- **THEN** bleiben Fenster, Sessions und Layout unverändert, und es wird nichts gespeichert

#### Scenario: Sessions behalten

- **GIVEN** der Dialog ist offen
- **WHEN** der Benutzer „Oberfläche schließen, Sessions behalten“ wählt
- **THEN** speichert der Main das Layout mit allen Fenstern, schließt die Verbindung und beendet die App; Core und Sessions laufen weiter

#### Scenario: Sessions beenden

- **GIVEN** der Dialog ist offen
- **WHEN** der Benutzer „Sessions beenden“ wählt
- **THEN** speichert der Main zuerst das Layout und sendet dann `core.shutdown { stopSessions: true }`, bevor die App endet

#### Scenario: Fenster der Frage verschwindet

- **GIVEN** der Dialog ist offen
- **WHEN** das Fenster neu geladen wird oder abstürzt
- **THEN** gilt die Frage als abgebrochen, und die App läuft weiter

#### Scenario: Fenster zeigt den Dialog nicht

- **GIVEN** der Main hat die Frage gesendet, aber der Renderer hat noch nicht zugehört oder hängt
- **WHEN** das Fenster den Dialog nicht binnen 5 s mit `quitShown` bestätigt (der Main sendet die Frage bis dahin alle 500 ms erneut und nach dem Laden der Seite)
- **THEN** gilt die Frage als abgebrochen: die App bleibt offen, nichts wird beendet, und das nächste Beenden fragt neu; nach der Bestätigung gibt es kein Zeitlimit

#### Scenario: Fokus bleibt im Dialog

- **GIVEN** der Dialog ist offen
- **WHEN** der Benutzer Tab oder Umschalt+Tab drückt oder der Fokus anderswohin springt
- **THEN** wandert der Fokus nur zwischen den Elementen des Dialogs bzw. kehrt dorthin zurück, und keine Taste erreicht das Terminal dahinter

### Requirement: Gespeicherte Wahl beim Beenden

Mit „Nicht mehr fragen“ SHALL der Main `confirmQuitWhileRunning: false` und die Wahl als `quitAction` per `settings.set` speichern, bevor er beendet; „Abbrechen“ speichert nie. Ist die Nachfrage aus, SHALL er die gespeicherte Aktion ohne Dialog anwenden (fehlend: Sessions behalten). Das Ende der Windows-Sitzung (`session-end`) SHALL nie fragen und die Sessions behalten. Antwortet der Core nicht, SHALL die App wie bisher beenden und die Sessions behalten.

#### Scenario: Nicht mehr fragen

- **GIVEN** der Dialog ist offen
- **WHEN** der Benutzer „Nicht mehr fragen“ setzt und „Sessions beenden“ wählt
- **THEN** sind `confirmQuitWhileRunning: false` und `quitAction: "stopSessions"` gespeichert, und das nächste Beenden mit laufenden Sessions beendet sie ohne Dialog

#### Scenario: Windows-Abmeldung

- **GIVEN** Sessions laufen, und die Nachfrage ist an oder die gespeicherte Aktion beendet Sessions
- **WHEN** Windows meldet `session-end`
- **THEN** erscheint kein Dialog, das Layout wird gespeichert, und die Sessions bleiben erhalten

#### Scenario: Core antwortet nicht

- **GIVEN** `session.list` scheitert beim Beenden
- **WHEN** der Benutzer die App beendet
- **THEN** beendet sich die App ohne Dialog und behält die Sessions

### Requirement: Screenshot-Szene des Schließen-Dialogs

Der Screenshot-Modus SHALL den Schließen-Dialog bei laufenden Sessions ohne und mit gesetztem „Nicht mehr fragen“ aufnehmen und über den echten Weg (Klick im Renderer, `answerQuit`, `settings.set` im isolierten Core) prüfen, dass „Abbrechen“ nichts speichert und eine gespeicherte Wahl nicht mehr fragt. Die Szene SHALL die Einstellungen danach zurücksetzen und die App nicht beenden.

#### Scenario: Szene des Dialogs

- **GIVEN** der Screenshot-Lauf hat Sessions in `Running` und `Detached`
- **WHEN** die Szene den Dialog öffnet, das Kästchen setzt, „Abbrechen“ und dann „Sessions beenden“ mit Kästchen wählt
- **THEN** liegen zwei PNG (`24-…`, `25-…`) im Ausgabeverzeichnis, die Entscheidungen stimmen, und der nächste Aufruf fragt nicht mehr
