## ADDED Requirements

### Requirement: Ausgabesequenz im Vertrag

Das Ergebnis von `session.attach` SHALL das optionale Feld `outputSeq` und das Event `session.output` das optionale Feld `seq` tragen, beide nicht negative ganze Zahlen. `seq` ist die Nummer der Ausgabe in ihrer Session; Ausgabe mit `seq` über `outputSeq` ist Live-Ausgabe der neuen View. Parser MUST andere Werte mit `bad_request` ablehnen. Die Protokollversion SHALL `1.1` sein; Clients mit `1.0` bleiben verträglich.

#### Scenario: Attach-Ergebnis mit Marke

- **GIVEN** eine Antwort auf `session.attach` mit `outputSeq: 7`
- **WHEN** sie geparst wird
- **THEN** ist sie gültig; ohne `outputSeq` ebenfalls, mit `outputSeq: -1` oder `"7"` ist das Ergebnis `bad_request`

#### Scenario: Ausgabe-Event mit Nummer

- **GIVEN** ein `event` `session.output` mit `sessionId`, `seq: 8` und Nutzdaten
- **WHEN** es geparst wird
- **THEN** liefert der Parser Session, Nummer und Bytes; mit `seq: 1.5` ist das Ergebnis `bad_request`

#### Scenario: Version 1.1

- **GIVEN** ein `hello` mit Version `1.0`
- **WHEN** die Version ausgehandelt wird
- **THEN** ist das Ergebnis erfolgreich und enthält die Core-Version `1.1`
