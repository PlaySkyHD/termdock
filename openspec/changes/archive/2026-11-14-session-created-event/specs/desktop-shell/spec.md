## MODIFIED Requirements

### Requirement: Events nur an beteiligte Fenster

Der Main SHALL Ausgabe, Größenänderung und Schreiberwechsel einer Session nur an Fenster senden, die eine View dieser Session haben oder gerade eine anhängen, je Fenster einmal. Zustandswechsel von Sessions SHALL er an alle Fenster senden, ebenso neue Sessions: Er leitet das Core-Event `session.created` als Brücken-Event `sessionCreated` an alle Fenster weiter und meldet nach `session.create` selbst nichts.

#### Scenario: Ausgabe einer Session

- **GIVEN** Fenster A zeigt Session `s1`, Fenster B zeigt Session `s2`
- **WHEN** der Core Ausgabe von `s1` meldet
- **THEN** erhält nur Fenster A die Bytes

#### Scenario: Ausgabe während des Anhängens

- **GIVEN** Fenster A hängt gerade eine View an `s1` an
- **WHEN** der Core direkt nach der Antwort Ausgabe von `s1` meldet
- **THEN** erhält Fenster A die Bytes mit ihrer Sequenznummer, und die View stellt sie nur dar, wenn der Snapshot sie nicht schon enthält

#### Scenario: Neue Session

- **GIVEN** Fenster A und B sind offen
- **WHEN** der Core `session.created` meldet, gleich von welchem Client die Session stammt
- **THEN** erhalten beide Fenster das Event `sessionCreated` mit der Session

#### Scenario: Eigener Aufruf

- **GIVEN** Fenster A und B sind offen
- **WHEN** A `createSession` erfolgreich aufruft
- **THEN** sendet der Main aus diesem Aufruf selbst kein `sessionCreated`; die Fenster erfahren es nur aus dem Core-Event

## ADDED Requirements

### Requirement: Neue Sessions in der Sidebar

Der Renderer SHALL eine Session aus dem Event `sessionCreated` in die Sidebar übernehmen und dabei idempotent sein: Dieselbe Session SHALL höchstens einmal erscheinen, wenn Event, Antwort auf `createSession` und `session.list` sie alle melden, und ein bekannter Zustand SHALL nicht auf einen älteren zurückfallen.

#### Scenario: Session eines anderen Clients

- **GIVEN** ein offenes Fenster mit geladener Liste
- **WHEN** ein anderer Core-Client eine Session anlegt
- **THEN** erscheint sie ohne Neuladen in der Sidebar

#### Scenario: Mehrfach gemeldet

- **GIVEN** ein Fenster, dessen erste Liste noch aussteht
- **WHEN** das Event zweimal eintrifft, die Liste die Session enthält und die Antwort von `createSession` ebenfalls
- **THEN** zeigt die Sidebar die Session einmal, im neuesten bekannten Zustand
