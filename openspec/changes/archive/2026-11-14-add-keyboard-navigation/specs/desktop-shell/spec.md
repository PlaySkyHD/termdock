# Spec Delta

## ADDED Requirements

### Requirement: Zentrale Keymap

Das Fenster SHALL alle Tastenkürzel aus einer Tabelle Befehl → Kürzel beziehen. Standard: `Ctrl+Shift+T` neue Session, `Ctrl+Shift+W` Tab schließen, `Ctrl+Tab`, `Ctrl+Shift+Tab` und `Ctrl+1…9` für Tabs, `Ctrl+Shift+D` und `Ctrl+Shift+E` teilen, `Alt+Pfeiltasten` Pane-Fokus, `Ctrl+Shift+B` Sidebar, `Ctrl+Shift+N` neues Fenster, `Ctrl+Shift+C` und `Ctrl+Shift+V` Zwischenablage, `Ctrl+Shift+H` Übersicht. Kein Standardkürzel SHALL `Ctrl+<Buchstabe>` ohne Shift sein.

#### Scenario: Taste zu Befehl

- **GIVEN** die Standardbelegung
- **WHEN** `Ctrl+Shift+D` gedrückt wird
- **THEN** ist der Befehl „rechts teilen“

#### Scenario: Nicht gebundene Taste

- **GIVEN** die Standardbelegung
- **WHEN** `Ctrl+C`, `Ctrl+B`, ein Buchstabe oder `Alt+1` gedrückt wird
- **THEN** gehört die Taste keinem Befehl

### Requirement: Kürzel vor xterm.js

Eine gebundene Taste SHALL im Terminal als Befehl laufen (`attachCustomKeyEventHandler`) und weder von xterm.js noch von der Shell verarbeitet werden; ihr Befehl SHALL einmal je Tastendruck laufen. Jede andere Taste SHALL unverändert an xterm.js gehen. Außerhalb des Terminals (Sidebar, leeres Fenster) SHALL ein Fenster-Listener dieselbe Tabelle anwenden. „Neues Fenster“ SHALL dem Menü-Accelerator bleiben.

#### Scenario: Tab per Kürzel

- **GIVEN** drei Tabs, der letzte ist aktiv
- **WHEN** der Benutzer `Ctrl+Tab` drückt
- **THEN** ist der erste Tab aktiv, und die Shell erhält keine Eingabe

#### Scenario: Interrupt bleibt bei der Shell

- **GIVEN** ein Befehl läuft im aktiven Pane
- **WHEN** der Benutzer `Ctrl+C` drückt
- **THEN** erhält die Shell ihn unverändert, und kein Befehl der App läuft

#### Scenario: Pane-Fokus

- **GIVEN** zwei Panes nebeneinander, das linke ist aktiv
- **WHEN** der Benutzer `Alt+Rechts` drückt
- **THEN** ist das rechte Pane aktiv und hat den Tastaturfokus; am Rand ändert sich nichts

### Requirement: Zwischenablage nur in der schreibenden View

`Ctrl+Shift+C` SHALL die Auswahl des aktiven Terminals unverändert kopieren. `Ctrl+Shift+V` und Rechtsklick SHALL die Zwischenablage über `Terminal.paste` einfügen (Zeilenumbruch wird CR, Bracketed Paste, wenn die Anwendung es anfordert). Eine lesende View SHALL weder einfügen noch die Zwischenablage lesen; die Statusleiste SHALL den Grund nennen. Fordert ein Programm Mausberichte an, SHALL der Rechtsklick an das Programm gehen.

#### Scenario: Mehrzeilig einfügen

- **GIVEN** die Shell fordert Bracketed Paste an und das Pane schreibt
- **WHEN** der Benutzer zwei Zeilen mit Umlauten einfügt
- **THEN** sendet das Fenster `ESC[200~` Text mit CR `ESC[201~` als `session.input`, und die Shell führt keine Zeile aus

#### Scenario: Einfügen im Leser

- **GIVEN** das aktive Pane liest
- **WHEN** der Benutzer `Ctrl+Shift+V` drückt
- **THEN** sendet das Fenster keine Eingabe, liest die Zwischenablage nicht, und die Statusleiste nennt „Einfügen nur im schreibenden Pane“

#### Scenario: Kopieren

- **GIVEN** Text im Terminal ist markiert
- **WHEN** der Benutzer `Ctrl+Shift+C` drückt
- **THEN** enthält die Zwischenablage genau diesen Text

### Requirement: Übersicht der Kürzel

Das Fenster SHALL die Kürzel aus der Keymap in einem Dialog anzeigen, geöffnet über eine Schaltfläche der Tab-Leiste oder `Ctrl+Shift+H`; Escape und die Schaltfläche SHALL ihn schließen, danach hat das aktive Terminal den Fokus.

#### Scenario: Übersicht öffnen und schließen

- **GIVEN** ein Fenster mit einem Terminal
- **WHEN** der Benutzer `Ctrl+Shift+H` und danach Escape drückt
- **THEN** erscheint der Dialog mit allen Kürzeln und verschwindet wieder; Escape erreicht die Shell nicht

### Requirement: Screenshot-Szenen für Tastenkürzel

Der Screenshot-Modus SHALL zusätzlich mit echten Tastenereignissen prüfen und aufnehmen: `Ctrl+C` erreicht die Shell, die Übersicht, mehrzeiliges Einfügen mit Umlauten ohne Ausführen, Kopieren, Teilen per Kürzel, Fokuswechsel, Einfügen im Leser (abgelehnt), ausgeblendete Sidebar und Schließen des Tabs. Wartet eine Szene vergeblich, SHALL der Lauf mit Code 1 enden.

#### Scenario: Aufnahme der Kürzel

- **WHEN** die App mit `--screenshot <dir>` startet
- **THEN** enthält `<dir>` zusätzlich PNG-Dateien der Übersicht, des eingefügten Texts, des abgelehnten Einfügens und des per Kürzel geteilten Fensters ohne Sidebar
