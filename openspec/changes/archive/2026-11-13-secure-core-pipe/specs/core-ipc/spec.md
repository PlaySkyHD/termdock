# Spec Delta

## ADDED Requirements

### Requirement: Zugriffsrechte der Pipe

Kein Konto außer dem Benutzer des Core, SYSTEM und den Administratoren SHALL Schreibzugriff auf die Pipe haben. Fremde Konten dürfen die Pipe höchstens lesend öffnen (Windows gewährt Everyone und Anonymous Lesezugriff auf Pipes ohne eigenen Sicherheitsdeskriptor); sie können keine Anfrage senden und erhalten keine Events oder Nutzdaten. Ein Windows-Test MUST die DACL der erzeugten Pipe prüfen.

#### Scenario: DACL der Core-Pipe

- **GIVEN** ein gestarteter Core auf einer Pipe (Windows)
- **WHEN** die DACL der Pipe gelesen wird
- **THEN** hat der aktuelle Benutzer Vollzugriff, und jeder andere Trustee außer SYSTEM und Administratoren ist Everyone oder Anonymous ohne Schreibrecht

### Requirement: Grenze für Verbindungen ohne Handshake

Der Core SHALL höchstens 32 Verbindungen gleichzeitig ohne abgeschlossenes `hello` halten (konfigurierbar, ganzzahlig und mindestens 1). Weitere neue Verbindungen MUST sofort ohne Antwort abgebaut werden. Ein Platz wird frei, sobald `hello` abgeschlossen ist oder die Verbindung schließt.

#### Scenario: Grenze erreicht

- **GIVEN** eine Grenze von 2 und zwei Verbindungen ohne `hello`
- **WHEN** eine dritte Verbindung aufgebaut wird
- **THEN** baut der Core sie sofort ab, die ersten beiden bleiben offen, und nach einem `hello` oder Schließen wird eine neue Verbindung wieder angenommen

### Requirement: Frist für den Handshake

Der Core SHALL eine Verbindung abbauen, die nicht innerhalb von 5 Sekunden nach dem Aufbau ein gültiges `hello` abgeschlossen hat. Die Frist ist konfigurierbar, muss aber eine positive endliche Zahl sein; sonst MUST der Start mit einem Fehler scheitern (es gibt kein „aus“). Der Timer MUST mit dem erfolgreichen `hello` und beim Schließen der Verbindung enden; eine Verbindung nach `hello` bleibt unbegrenzt offen.

#### Scenario: Verbindung ohne hello

- **GIVEN** eine frisch aufgebaute Verbindung, die nichts sendet
- **WHEN** die Frist abläuft
- **THEN** baut der Core die Verbindung ab, ohne etwas zu senden

#### Scenario: Verbindung nach hello

- **GIVEN** ein Client, der `hello` innerhalb der Frist abgeschlossen hat
- **WHEN** die Frist verstrichen ist
- **THEN** bleibt die Verbindung offen und beantwortet weitere Anfragen
