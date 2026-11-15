## ADDED Requirements

### Requirement: Treffer der Suche per Tastatur wählen

Im Suchdialog SHALL Pfeil runter und hoch den nächsten und vorigen Treffer über alle Gruppen wählen und an den Enden stehen bleiben; Pos1 und Ende wählen den ersten und letzten, sobald einer gewählt ist. Der gewählte Treffer MUST hervorgehoben sein. Enter SHALL ihn wie ein Klick öffnen; ohne Auswahl oder nach geändertem Suchtext startet Enter die Suche. Neue Ergebnisse setzen die Auswahl zurück. Der Fokus SHALL im Suchfeld bleiben (`combobox`, `listbox`, `aria-activedescendant`).

#### Scenario: Mit Pfeiltasten wählen

- **GIVEN** der Dialog zeigt Treffer in zwei Gruppen, nichts ist gewählt
- **WHEN** der Benutzer so oft Pfeil runter drückt, bis der erste Treffer der zweiten Gruppe erreicht ist
- **THEN** ist genau dieser Treffer hervorgehoben (`aria-selected`), das Suchfeld verweist mit `aria-activedescendant` auf ihn und hat weiter den Fokus

#### Scenario: Enter öffnet

- **GIVEN** ein Treffer der Session „Deploy“ ist gewählt
- **WHEN** der Benutzer Enter drückt
- **THEN** schließt der Dialog und der Tab von „Deploy“ ist aktiv

#### Scenario: Enter ohne Auswahl oder nach neuem Text

- **GIVEN** der Dialog zeigt Treffer ohne Auswahl, oder der Suchtext wurde seit dem Ergebnis geändert
- **WHEN** der Benutzer Enter drückt
- **THEN** startet die Suche sofort, und kein Treffer des alten Ergebnisses wird geöffnet

#### Scenario: Enden und Neustart

- **GIVEN** der letzte Treffer ist gewählt
- **WHEN** der Benutzer Pfeil runter drückt
- **THEN** bleibt der letzte Treffer gewählt; nach einem neuen Ergebnis ist nichts gewählt

#### Scenario: Pos1 und Ende bewegen den Cursor ohne Auswahl

- **GIVEN** der Dialog zeigt Treffer, nichts ist gewählt
- **WHEN** der Benutzer Pos1 drückt
- **THEN** bewegt sich der Textcursor im Suchfeld, und die Auswahl bleibt leer

## MODIFIED Requirements

### Requirement: Screenshot-Szene der Verlaufssuche

Der Screenshot-Modus SHALL den Suchdialog leer und mit Treffern aus zwei Sessions aufnehmen, über den echten Weg (Kürzel, Eingabe, Brücke, Core-Suche) prüfen, dass beide Sessions in den Gruppen stehen, und einen Klick auf einen Treffer aufnehmen. Danach SHALL sie mit echten Tastenereignissen per Pfeil einen Treffer der zweiten Gruppe wählen, den Dialog aufnehmen, mit Enter die Session öffnen und aufnehmen; weicht eine Prüfung ab, endet der Lauf mit Exit-Code 1.

#### Scenario: Szene der Suche

- **GIVEN** zwei Sessions, die „deploy“ ausgegeben haben
- **WHEN** die Szene `Ctrl+Shift+F` drückt, „deploy“ eingibt und einen Treffer anklickt
- **THEN** liegen drei PNG (`26-…` bis `28-…`) im Ausgabeverzeichnis und der Tab der gewählten Session ist aktiv

#### Scenario: Szene der Tastaturwahl

- **GIVEN** der Dialog zeigt Treffer in zwei Gruppen
- **WHEN** die Szene Pfeil runter bis zum ersten Treffer der zweiten Gruppe und dann Enter drückt
- **THEN** liegen zwei weitere PNG (`29-…`, `30-…`) vor, und der Tab der zweiten Gruppe ist aktiv
