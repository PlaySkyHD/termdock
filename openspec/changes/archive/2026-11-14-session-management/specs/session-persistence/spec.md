## MODIFIED Requirements

### Requirement: Durchschreiben aus der Registry

Ist ein Repository angebunden, SHALL der Core jede Änderung einer Session sofort speichern: Anlegen, jeden Zustandswechsel, Exit-Code, Terminalgröße, Name, Workspace, Verlauf-Schalter und Änderungszeit. Ein Zustandswechsel MUST gespeichert sein, bevor er gemeldet wird. Das Löschen einer Session MUST ihre Zeile entfernen; ein neuer Core MUST sie nicht mehr laden. Ohne Repository MUST sich der Core unverändert verhalten.

#### Scenario: Zustandswechsel wird gespeichert

- **GIVEN** eine Registry mit Repository
- **WHEN** eine Session angelegt wird und ihr Prozess danach mit Exit-Code 3 endet
- **THEN** enthält das Repository die Session im Zustand `Exited` mit letztem Exit-Code 3

#### Scenario: Gespeichert vor der Meldung

- **GIVEN** eine Registry mit Repository und ein Listener für Zustandswechsel
- **WHEN** die Session ihren Zustand ändert
- **THEN** liest der Listener den neuen Zustand bereits aus dem Repository

#### Scenario: Größe wird gespeichert

- **GIVEN** eine laufende Session mit Schreiber
- **WHEN** der Schreiber die Größe 120×40 setzt
- **THEN** enthält das Repository die Größe 120×40

#### Scenario: Umbenennen und Verschieben werden gespeichert

- **GIVEN** eine Registry mit Repository und eine Session im Workspace `w1`
- **WHEN** sie umbenannt und gruppenlos gemacht wird
- **THEN** enthält das Repository den neuen Namen, keinen Workspace und die neue Änderungszeit

#### Scenario: Gelöschte Session wird nicht mehr geladen

- **GIVEN** ein Core mit Datenbankdatei und zwei Sessions, von denen eine gelöscht wurde
- **WHEN** ein neuer Core auf derselben Datei startet
- **THEN** listet er nur die andere Session

## ADDED Requirements

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
