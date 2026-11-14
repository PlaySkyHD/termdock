## MODIFIED Requirements

### Requirement: Events

Der Core SHALL Clients über die Events `session.output` (Bytes in den Nutzdaten), `session.stateChanged`, `session.resized`, `view.writerChanged` und `session.created` (seit 1.2, mit der `SessionInfo` einer neuen Session) informieren; Parser SHALL ihre Payloads prüfen.

#### Scenario: Ausgabe-Event

- **GIVEN** ein `event` `session.output` mit `sessionId` und Nutzdaten
- **WHEN** es geparst wird
- **THEN** liefert der Parser Session und Bytes; ohne Nutzdaten ist das Ergebnis `bad_request`

#### Scenario: Schreiberwechsel ohne Schreiber

- **GIVEN** ein `event` `view.writerChanged` ohne `writerViewId`
- **WHEN** es geparst wird
- **THEN** ist das gültig und bedeutet: aktuell schreibt keine View

#### Scenario: Event für neue Session

- **GIVEN** ein `event` `session.created` mit `data.session` als gültiger `SessionInfo`
- **WHEN** es geparst wird
- **THEN** liefert der Parser die Session; ohne `session`, mit ungültigem Zustand oder mit Nutzdaten ist das Ergebnis `bad_request`

### Requirement: Ausgabesequenz im Vertrag

Das Ergebnis von `session.attach` SHALL das optionale Feld `outputSeq` und das Event `session.output` das optionale Feld `seq` tragen, beide nicht negative ganze Zahlen. `seq` ist die Nummer der Ausgabe in ihrer Session; Ausgabe mit `seq` über `outputSeq` ist Live-Ausgabe der neuen View. Parser MUST andere Werte mit `bad_request` ablehnen. Die Protokollversion SHALL `1.2` sein (1.1: Ausgabesequenz, 1.2: `session.created`); Clients mit `1.0` und `1.1` bleiben verträglich.

#### Scenario: Attach-Ergebnis mit Marke

- **GIVEN** eine Antwort auf `session.attach` mit `outputSeq: 7`
- **WHEN** sie geparst wird
- **THEN** ist sie gültig; ohne `outputSeq` ebenfalls, mit `outputSeq: -1` oder `"7"` ist das Ergebnis `bad_request`

#### Scenario: Ausgabe-Event mit Nummer

- **GIVEN** ein `event` `session.output` mit `sessionId`, `seq: 8` und Nutzdaten
- **WHEN** es geparst wird
- **THEN** liefert der Parser Session, Nummer und Bytes; mit `seq: 1.5` ist das Ergebnis `bad_request`

#### Scenario: Version 1.1

- **GIVEN** ein `hello` mit Version `1.0` oder `1.1`
- **WHEN** die Version ausgehandelt wird
- **THEN** ist das Ergebnis erfolgreich und enthält die Core-Version `1.2`
