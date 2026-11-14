## MODIFIED Requirements

### Requirement: Snapshot für neue Views

Beim Anhängen SHALL eine View einen Snapshot erhalten. Liefert das Backend einen eigenen Bildschirminhalt, MUST dieser unverändert hinter den Terminal-Modi der Session verwendet werden, samt Feld `cursor`; Ausgabe, die während der Abfrage eintrifft, MUST NOT angehängt werden. Liefert das Backend nichts oder schlägt die Abfrage fehl, MUST der Inhalt des Rohdaten-Puffers hinter den Terminal-Modi verwendet werden. Der Puffer MUST auf die letzten 256 KiB Ausgabe je Session begrenzt sein.

#### Scenario: Fallback auf den Puffer

- **GIVEN** ein Backend ohne eigenen Snapshot und eine Session, die 300 KiB ausgegeben hat
- **WHEN** eine View angehängt wird
- **THEN** enthält ihr Snapshot genau die letzten 256 KiB der Ausgabe

#### Scenario: Snapshot des Backends

- **GIVEN** ein Backend, das für die Session einen Bildschirminhalt mit Cursor liefert
- **WHEN** eine View angehängt wird
- **THEN** enthält ihr Snapshot diese Daten und das Feld `cursor`

#### Scenario: Ausgabe während der Snapshot-Abfrage

- **GIVEN** ein Backend, das Bildschirminhalt mit Cursorposition liefert
- **WHEN** während der Abfrage weitere Ausgabe eintrifft
- **THEN** enthält der Snapshot nur den Bildschirminhalt mit dem Feld `cursor`, und die neue View erhält diese Ausgabe nicht

#### Scenario: Snapshot-Abfrage schlägt fehl

- **GIVEN** ein Backend, dessen Snapshot-Abfrage fehlschlägt
- **WHEN** eine View angehängt wird
- **THEN** gelingt das Anhängen und der Snapshot enthält den Rohdaten-Puffer

## ADDED Requirements

### Requirement: Terminal-Modi im Snapshot

Der Core SHALL in der Ausgabe jeder Session diese Modi verfolgen: Application Cursor Keys, Application Keypad, Mausberichte (Protokoll und Kodierung), Fokusberichte und Bracketed Paste. Der Snapshot einer neuen View MUST mit den Sequenzen beginnen, die genau die eingeschalteten Modi nach der Ausgabe bis `outputSeq` herstellen; ohne eingeschalteten Modus MUST er ohne Präfix beginnen. Ein Neustart MUST die Modi zurücksetzen.

#### Scenario: Späte View erhält die Modi

- **GIVEN** eine Session, deren PTY `ESC[?1h`, `ESC=`, `ESC[?1006h`, `ESC[?1000h`, `ESC[?1002h` und `ESC[?2004h` ausgegeben hat, und ein Backend mit Bildschirminhalt `screen`
- **WHEN** eine View angehängt wird
- **THEN** beginnt ihr Snapshot mit `ESC[?1h`, `ESC=`, `ESC[?1002h`, `ESC[?1006h` und `ESC[?2004h`, gefolgt von `screen`

#### Scenario: Ausgeschaltete Modi

- **GIVEN** eine Session, deren PTY Mausberichte und Bracketed Paste ein- und wieder ausgeschaltet hat
- **WHEN** eine View angehängt wird
- **THEN** enthält ihr Snapshot keine Sequenz für diese Modi

#### Scenario: Sequenz über zwei Ausgaben verteilt

- **GIVEN** eine Session, deren PTY `ESC[?20` und danach `04h` ausgibt
- **WHEN** eine View angehängt wird
- **THEN** beginnt ihr Snapshot mit `ESC[?2004h`

#### Scenario: Modi nach Neustart

- **GIVEN** eine beendete Session, deren PTY Bracketed Paste eingeschaltet hatte
- **WHEN** sie neu gestartet wird und eine View anhängt, bevor die neue PTY Modi setzt
- **THEN** enthält der Snapshot keine Sequenz für Bracketed Paste

#### Scenario: Zweite View einer tmux-Session mit Maus und TUI

- **GIVEN** eine WSL-Session mit `set -g mouse on`, in der `less` läuft, und eine View A, die vor dem Einschalten der Maus angehängt hat und als Schreiber die Größe bestimmt
- **WHEN** eine lesende View B später anhängt
- **THEN** haben A und B dieselben Modi: Mausberichte, Application Cursor Keys, Application Keypad und Bracketed Paste sind eingeschaltet
