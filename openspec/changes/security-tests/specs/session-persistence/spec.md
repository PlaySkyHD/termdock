## ADDED Requirements

### Requirement: Keine Geheimnisse in gespeicherten Sessions

Der Core SHALL `session.create` mit `bad_request` ablehnen, wenn ein Schlüssel von `launch.env` wie bei Profilen einen Geheimnis-Namen trägt (`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY` und Co. am Ende), auch mit `profileId` und eigenem `launch`, bevor er etwas speichert oder startet. Die Meldung MUST den Schlüssel nennen, nie den Wert. Ein Umgebungswert MUST in der Datenbank nur in der `env`-Spalte des Profils oder der Session stehen, in die der Nutzer ihn eingetragen hat.

#### Scenario: Geheimnis in einer eigenen Session

- **GIVEN** ein Core mit einem Profil ohne Umgebung
- **WHEN** ein Client `session.create` mit `launch.env { GITHUB_TOKEN: "td-test-secret-0000" }` sendet, ohne und mit `profileId`
- **THEN** antwortet der Core mit `bad_request`, die Meldung nennt `GITHUB_TOKEN` und nicht den Wert, keine Session ist gespeichert und das Backend hat nichts gestartet; `LANG` und `TOKENS_PER_MIN` sind erlaubt

#### Scenario: Umgebungswert in der Datenbank

- **GIVEN** ein Profil mit `launch.env { TD_TEST_VALUE: "td-test-secret-0000" }` und daraus gestartete, gescheiterte und abgelehnte Sessions
- **WHEN** alle Zellen aller Tabellen der Datenbank gelesen werden
- **THEN** steht der Wert nur in `launch_profiles.env` und `sessions.env`, und kein anderer Dateiinhalt im Datenordner enthält ihn

## MODIFIED Requirements

### Requirement: Verlauf beim Löschen entfernen

Beim Löschen einer Session SHALL der Core das Verzeichnis `history/<sessionId>/` im Datenverzeichnis rekursiv entfernen, bevor er ihre Zeile entfernt; ein fehlendes Verzeichnis MUST kein Fehler sein. Der Pfad MUST nur aus einer Session-ID aus Buchstaben, Ziffern, `-` und `_` entstehen und unter `history/` liegen, sonst MUST nichts entfernt werden. Archivieren MUST den Verlauf nicht entfernen.

#### Scenario: Verlauf wird entfernt

- **GIVEN** zwei Sessions mit Verlaufsverzeichnis, von denen eine `Exited` ist
- **WHEN** die beendete Session gelöscht wird
- **THEN** fehlt ihr Verzeichnis unter `history/`, das der anderen besteht weiter

#### Scenario: Kein Verlauf vorhanden

- **GIVEN** eine Session ohne Verlaufsverzeichnis
- **WHEN** ihr Verlauf zweimal entfernt wird
- **THEN** gelingen beide Aufrufe

#### Scenario: Ungültige Session-ID

- **GIVEN** eine Session-ID `..` oder mit Pfadtrenner
- **WHEN** ihr Verlauf entfernt werden soll
- **THEN** schlägt der Aufruf fehl und keine Datei im Datenverzeichnis ist entfernt

#### Scenario: Verlauf kann nicht entfernt werden

- **GIVEN** eine `Exited`-Session, deren Verlauf sich nicht entfernen lässt
- **WHEN** sie gelöscht wird
- **THEN** schlägt der Aufruf mit `internal` fehl und die Session ist weiter gespeichert

#### Scenario: Löschen nach einem Core-Neustart

- **GIVEN** zwei Sessions, deren Ausgabe vor einem Neustart des Core in `history/` geschrieben wurde
- **WHEN** nach dem Neustart eine von ihnen beendet und gelöscht wird und der Core danach noch einmal startet
- **THEN** fehlt ihr Verzeichnis nach dem Löschen und nach beiden Abbauten, der dritte Core listet nur die andere Session, und die Suche findet nur deren Verlauf
