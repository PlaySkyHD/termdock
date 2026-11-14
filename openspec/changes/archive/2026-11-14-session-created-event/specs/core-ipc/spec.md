## ADDED Requirements

### Requirement: Event für neue Sessions

Der Core SHALL nach dem Eintragen einer Session durch `session.create` das Event `session.created` mit der Session im Zustand `Starting` an jede Verbindung senden, die `session.list` genutzt hat (wie `session.stateChanged`), auch an die anfragende, einmal je Verbindung. Es MUST vor der Antwort und vor jedem `session.stateChanged` der Session eintreffen. Vor dem Eintragen abgelehnt (`bad_request`, Shutdown, Speicherfehler) oder beim Laden gespeicherter Sessions SHALL der Core es nicht senden.

#### Scenario: Zweiter Client sieht die neue Session

- **GIVEN** Client A und Client B sind verbunden und haben `session.list` genutzt, Client C nicht
- **WHEN** A `session.create` aufruft
- **THEN** erhält B `session.created` mit der neuen Session, A erhält es vor der Antwort, C erhält es nicht

#### Scenario: Abgelehnte Anfrage

- **GIVEN** zwei verbundene Clients, die `session.list` genutzt haben
- **WHEN** `session.create` vor dem Eintragen mit `bad_request` abgelehnt wird
- **THEN** erhält kein Client ein `session.created`

#### Scenario: Start scheitert

- **GIVEN** ein Client, der `session.list` genutzt hat, und ein nicht erreichbarer Backend-Start
- **WHEN** ein anderer Client `session.create` aufruft und mit `backend_unavailable` eine Absage erhält
- **THEN** erhält der erste Client `session.created` im Zustand `Starting` und danach `session.stateChanged` mit `Interrupted`

#### Scenario: Gespeicherte Sessions beim Start

- **GIVEN** gespeicherte Sessions und ein Core, der sie beim Start lädt
- **WHEN** der Reconcile abgeschlossen ist
- **THEN** wurde für keine davon `session.created` gesendet; Clients lesen sie mit `session.list`
