## ADDED Requirements

### Requirement: Schreibfehler einmal je Fehlerstrecke melden

Scheitert das Schreiben des Verlaufs einer Session (Platte voll, Ordner schreibgeschützt), SHALL der Core den Fehler einmal melden und weitere Fehler dieser Session nicht melden, bis wieder ein Schreiben gelingt; danach MUST der nächste Fehler wieder gemeldet werden. Die verworfenen Einträge MUST weiter vollständig gezählt werden.

#### Scenario: Anhaltender Schreibfehler

- **GIVEN** ein Datenverzeichnis, in dem `history/` nicht angelegt werden kann
- **WHEN** eine Session fünfmal Ausgabe speichern will und eine zweite Session einmal
- **THEN** wird je Session ein Fehler gemeldet und fünf Einträge der ersten Session zählen als verworfen

#### Scenario: Schreiben gelingt wieder

- **GIVEN** eine Session, deren Schreibfehler gemeldet wurde
- **WHEN** `history/` wieder angelegt werden kann, ein Schreiben gelingt und danach erneut eines scheitert
- **THEN** steht die Ausgabe des gelungenen Schreibens im Verlauf und der neue Fehler wird wieder gemeldet
