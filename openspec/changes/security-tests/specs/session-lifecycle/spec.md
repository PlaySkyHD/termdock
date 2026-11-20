## ADDED Requirements

### Requirement: Terminal-Ausgabe ist Daten

Der Core SHALL die Ausgabe einer Session Byte für Byte an Views, Snapshot und Verlauf weitergeben, auch Escape-Sequenzen wie OSC 52 (Clipboard), OSC 8 (Links) und Titel (OSC 0/2). Er MUST keine Sequenz ausführen oder beantworten und nichts aus der Ausgabe an die PTY schreiben; nur der Terminal-Emulator einer View interpretiert sie. Ihr Inhalt MUST weder in Suchtreffern noch im Log stehen.

#### Scenario: OSC 52, OSC 8 und Titel

- **GIVEN** eine Session mit angehängter View
- **WHEN** sie OSC 52 (Schreiben und Abfrage), einen OSC-8-Link und OSC 0/2 mit Text `td-test …` ausgibt
- **THEN** erhält die View genau diese Bytes, eine später angehängte View sie im Snapshot, der Verlauf speichert sie, die PTY erhält keine Eingabe, und weder die Suche nach `td-test` noch `core.log` zeigt ihren Inhalt
