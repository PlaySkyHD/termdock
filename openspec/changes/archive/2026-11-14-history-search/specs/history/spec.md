## ADDED Requirements

### Requirement: Suche im Verlauf

Der Core SHALL mit `history.search` den gespeicherten Verlauf aller Sessions mit Verlauf, auch archivierter, oder der genannten `sessionIds` durchsuchen: Klartext ohne Beachtung der Groß- und Kleinschreibung, Escape-Sequenzen erst beim Lesen entfernt (nie interpretiert, auch über Eintragsgrenzen), ein Treffer je Zeile mit Session, Zeitstempel und Zeile (höchstens 512 Zeichen) um den Treffer, neueste zuerst. Der Core MUST Verlauf lesen wie `HistoryStore.read` (Lese-Lock gegen Rotation).

#### Scenario: Treffer in zwei Sessions

- **GIVEN** zwei Sessions mit gespeichertem „Build FAILED“ (mit Farbsequenzen) und „tests failed“
- **WHEN** der Client „failed“ sucht
- **THEN** liefert der Core je einen Treffer mit der Zeile ohne Escape-Sequenzen, der Position des Treffers und dem Zeitstempel, den neuesten zuerst

#### Scenario: Zeile über Eintragsgrenzen

- **GIVEN** eine Zeile „hello world“, deren Bytes auf zwei Einträge verteilt sind, und eine Escape-Sequenz, die zwischen zwei Einträgen endet
- **WHEN** der Client „world“ sucht
- **THEN** liefert der Core die Zeile als einen Treffer, und Sequenzen sind weder Treffer noch Teil der Zeile

#### Scenario: Treffer in beiden Segmenten

- **GIVEN** eine Session, deren Ringpuffer gewechselt hat und in beiden Segmenten Treffer enthält
- **WHEN** der Client sucht
- **THEN** liefert der Core die Treffer beider Segmente lückenlos bis zur jüngsten Zeile

#### Scenario: Ohne Verlauf oder gelöscht

- **GIVEN** eine Session mit `loggingEnabled: false`, eine gelöschte Session und ein Verlauf ohne Session
- **WHEN** der Client sucht
- **THEN** liefert der Core für keine von ihnen einen Treffer, auch nicht mit ihrer ID in `sessionIds`

### Requirement: Grenzen der Suche

Die Suche MUST begrenzt bleiben: höchstens `limit` Treffer (Standard und Höchstwert 200), Zeilenpuffer von 4096 Zeichen beim Lesen (mit Überlappung, damit ein Treffer über den Schnitt gefunden wird), Laufzeit von 5 s. Gibt es mehr Treffer oder endet die Zeit, SHALL der Core die neuesten gefundenen Treffer mit `truncated: true` liefern. Ein Suchtext SHALL als Text gelten, nicht als Muster; ein Suchtext mit Zeilenumbruch findet nichts.

#### Scenario: Mehr Treffer als Limit

- **GIVEN** eine Session mit zehn passenden Zeilen
- **WHEN** der Client mit `limit: 3` sucht
- **THEN** liefert der Core die drei neuesten und `truncated: true`; mit `limit: 10` zehn und `truncated: false`

#### Scenario: Zeitgrenze

- **GIVEN** eine Suche, die länger als die Zeitgrenze liest
- **WHEN** die Zeit abläuft
- **THEN** endet sie mit dem bisherigen Ergebnis und `truncated: true`, und der Lese-Lock ist freigegeben

#### Scenario: Rotation während der Suche

- **GIVEN** eine laufende Suche und Ausgabe, die einen Segmentwechsel auslöst
- **WHEN** die Suche liest
- **THEN** liefert sie genau, was bei ihrem Beginn gespeichert war, jede Zeile vollständig und einmal, und das Schreiben läuft danach weiter

#### Scenario: Suchtext mit Sonderzeichen

- **GIVEN** Zeilen „a.c“ und „abc“
- **WHEN** der Client „a.c“ sucht
- **THEN** liefert der Core nur „a.c“
