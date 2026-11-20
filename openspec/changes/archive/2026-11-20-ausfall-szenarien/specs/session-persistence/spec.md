## ADDED Requirements

### Requirement: Datenbank verweigert das Schreiben

Verweigert die Datenbank jedes Schreiben (Platte voll, Ordner schreibgeschützt), SHALL der Core jede schreibende Anfrage mit `internal` beantworten, weiterlaufen und laufende Sessions weiter bedienen (Ausgabe, Eingabe, Zustandswechsel); eine neue Session MUST dabei nicht gestartet werden. Ist wieder Platz, MUST der Core ohne Neustart wieder speichern.

#### Scenario: Platte voll

- **GIVEN** ein laufender Core mit einer Session und einer schreibenden View, dessen Datenbank jedes Schreiben mit „database or disk is full“ ablehnt und in dessen Datenverzeichnis `history/` nicht angelegt werden kann
- **WHEN** ein Client `layout.save`, `settings.set` und `session.create` sendet, die Session Ausgabe liefert, die View Eingabe sendet und die PTY mit Exit-Code 0 endet
- **THEN** antworten die drei Anfragen mit `internal`, das Backend erhielt keinen zweiten Start, die View erhält die Ausgabe, die Eingabe erreicht den Prozess, der Client erhält `Exited`, und `logs/core.log` nennt den Fehler des Verlaufs genau einmal

#### Scenario: Wieder Platz

- **GIVEN** derselbe Core, nachdem die Datenbank wieder schreibt
- **WHEN** ein Client `layout.save` sendet
- **THEN** antwortet der Core mit Revision 1

### Requirement: Daten nach hartem Ende des Core

Wird der Core-Prozess hart beendet (ohne `core.shutdown`, z. B. Task-Manager), während Ausgabe in den Verlauf geschrieben und das Layout gespeichert wird, SHALL der nächste Start eine intakte Datenbank, einen lesbaren Verlauf im Limit und ein Layout vorfinden, dessen Revision zu seinem Dokument gehört. Gespeicherte Sessions in `Detached` MUST der Abgleich wie jedes Ende des Core behandeln.

#### Scenario: Kill während Verlauf und Layout schreiben

- **GIVEN** ein Core als eigener Prozess mit Verlaufslimit 64 KiB, einer Session mit Dauerausgabe, mindestens einem Segmentwechsel und einem Client, der das Layout fortlaufend mit `baseRevision` speichert
- **WHEN** der Prozess hart beendet wird
- **THEN** liefert `PRAGMA integrity_check` `ok`, die Revision des Layouts ist die zuletzt bestätigte oder die folgende und das Dokument ist das dieser Speicherung, beide Segmente zusammen sind höchstens 64 KiB groß, der Verlauf liefert lückenlos aufeinanderfolgende ganze Zeilen, und der nächste Core meldet die Session von `Detached` nach `Interrupted`
