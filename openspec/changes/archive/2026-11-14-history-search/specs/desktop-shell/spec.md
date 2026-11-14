## ADDED Requirements

### Requirement: Suchdialog für den Verlauf

Die Oberfläche SHALL mit `Ctrl+Shift+F` (Befehl `searchHistory`) und einer Schaltfläche der Tab-Leiste einen modalen Suchdialog öffnen und schließen. Er SHALL 250 ms nach der letzten Eingabe, mit Enter sofort, über die Brücke den Verlauf aller Sessions suchen und nur die Antwort der neuesten Suche zeigen. Treffer SHALL nach Session gruppiert mit Zeit und Zeilenausschnitt als Text erscheinen, nie interpretiert. Solange er offen ist, MUST nur sein Befehl wirken; Escape schließt ihn.

#### Scenario: Suchen

- **GIVEN** zwei Sessions mit gespeichertem „deploy“ in der Ausgabe
- **WHEN** der Benutzer `Ctrl+Shift+F` drückt und „deploy“ eingibt
- **THEN** zeigt der Dialog Treffer in zwei Gruppen mit den Namen der Sessions und hervorgehobenem Treffer

#### Scenario: Treffer öffnen

- **GIVEN** der Dialog zeigt Treffer einer Session
- **WHEN** der Benutzer einen Treffer anklickt
- **THEN** schließt der Dialog und der Tab der Session ist aktiv (neu geöffnet oder fokussiert; eine nicht lebende Session als Platzhalter)

#### Scenario: Späte Antwort

- **GIVEN** eine Suche nach „a“ ist unterwegs
- **WHEN** der Benutzer „ab“ sucht und die Antwort auf „a“ erst danach eintrifft
- **THEN** zeigt der Dialog das Ergebnis für „ab“

#### Scenario: Fehler und keine Treffer

- **GIVEN** der Dialog ist offen
- **WHEN** die Suche scheitert oder nichts findet
- **THEN** nennt er den Fehler bzw. „Keine Treffer“, und Eingabe bleibt möglich

#### Scenario: Modal

- **GIVEN** der Dialog ist offen
- **WHEN** der Benutzer `Ctrl+Shift+T`, `Ctrl+Shift+H` oder `Ctrl+Shift+V` drückt
- **THEN** wirkt keiner dieser Befehle, und die Taste erreicht das Terminal nicht

### Requirement: Screenshot-Szene der Verlaufssuche

Der Screenshot-Modus SHALL den Suchdialog leer und mit Treffern aus zwei Sessions aufnehmen, über den echten Weg (Kürzel, Eingabe, Brücke, Core-Suche) prüfen, dass beide Sessions in den Gruppen stehen, und einen Klick auf einen Treffer aufnehmen.

#### Scenario: Szene der Suche

- **GIVEN** zwei Sessions, die „deploy“ ausgegeben haben
- **WHEN** die Szene `Ctrl+Shift+F` drückt, „deploy“ eingibt und einen Treffer anklickt
- **THEN** liegen drei PNG (`26-…` bis `28-…`) im Ausgabeverzeichnis und der Tab der gewählten Session ist aktiv
