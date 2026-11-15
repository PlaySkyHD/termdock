## ADDED Requirements

### Requirement: Screenshot-Szenen prüfen die Sichtbarkeit ihres Kernelements

Eine Szene des Screenshot-Modus mit Fehlermeldung, Menü oder Dialog SHALL vor der Aufnahme prüfen, dass das Kernelement existiert und vollständig im nächsten scrollbaren Vorfahren und im Fenster liegt. Sonst SHALL der Lauf mit Code 1 enden und Szenenname und Selektor nennen.

#### Scenario: Element abgeschnitten

- **GIVEN** die Meldung einer Szene liegt unterhalb des sichtbaren Bereichs ihres scrollbaren Panels
- **WHEN** die Szene aufnimmt
- **THEN** endet der Lauf mit Code 1, und die Meldung nennt Szene und Selektor

#### Scenario: Element vollständig sichtbar

- **GIVEN** das Menü einer Szene liegt ganz im Fenster
- **WHEN** die Szene aufnimmt
- **THEN** wird das PNG geschrieben
