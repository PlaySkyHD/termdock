## ADDED Requirements

### Requirement: Sequenznummer und Marke vom Core

Der Main SHALL jeder Ausgabe an die Fenster die Nummer `seq` des Core mitgeben und als Marke der Attach-Antwort `outputSeq` des Core verwenden. Fehlen die Felder (Core mit Protokoll 1.0), SHALL er die Ausgabe je Session selbst ab 1 zählen und als Marke die zuletzt gezählte Nummer nehmen.

#### Scenario: Zurückgehaltene Ausgabe in einem späteren Lesevorgang

- **GIVEN** Fenster A hat eine View von `s1` und hängt eine zweite an; der Core antwortet mit `outputSeq: 5`
- **WHEN** Ausgabe von `s1` mit `seq` 5 erst nach der Antwort beim Main eintrifft, danach Ausgabe mit `seq` 6
- **THEN** meldet der Main die Marke 5, und die neue View stellt nur die Ausgabe 6 dar

#### Scenario: Core ohne Nummern

- **GIVEN** ein Core, der weder `seq` noch `outputSeq` sendet
- **WHEN** zwei Ausgaben von `s1` eintreffen und danach eine View angehängt wird
- **THEN** tragen die Ausgaben die Nummern 1 und 2, und die Marke ist 2
