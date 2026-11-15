## ADDED Requirements

### Requirement: Neuzeichnen nach Größenänderung nicht speichern

Ändert die schreibende View die Größe einer Session mit PTY, SHALL die Registry vor der Größenänderung der PTY ein Neuzeichnen anfordern; die Ausgabe während dieses Laufs ist gekennzeichnet wie beim Anhängen, und der Verlauf MUST sie nicht speichern. Größenänderungen, während ein Neuzeichnen läuft, SHALL die Registry zu genau einem folgenden zusammenfassen. Eine Größenänderung auf die bisherige Größe MUST kein Neuzeichnen anfordern. Views MUST die Ausgabe unverändert erhalten.

#### Scenario: Größenänderung

- **GIVEN** eine WSL-Session mit Logging, einer schreibenden View und gespeicherter Ausgabe „seen-42“
- **WHEN** die View die Größe ändert und tmux den Bildschirm neu in die PTY schreibt
- **THEN** entsteht kein neuer Verlaufseintrag, und die View erhält das Neuzeichnen als Ausgabe

#### Scenario: Fenster ziehen

- **GIVEN** eine Session, deren Neuzeichnen nach einer Größenänderung noch läuft
- **WHEN** zwei weitere Größenänderungen folgen und tmux jedes Mal neu zeichnet
- **THEN** läuft genau ein weiteres Neuzeichnen danach, und keine dieser Ausgaben wird gespeichert

#### Scenario: Ausgabe nach der Größenänderung

- **GIVEN** eine Session, deren Neuzeichnen nach einer Größenänderung beendet ist
- **WHEN** das Programm „after-2“ ausgibt
- **THEN** speichert der Verlauf „after-2“

#### Scenario: Gleiche Größe

- **GIVEN** eine Session mit PTY und der Größe 80×24
- **WHEN** die schreibende View die Größe 80×24 sendet
- **THEN** fordert die Registry kein Neuzeichnen an, und die folgende Ausgabe wird gespeichert

## MODIFIED Requirements

### Requirement: Neuzeichnen beim Anhängen nicht speichern

Fordert die Registry nach dem Anhängen einer View ein Neuzeichnen an, SHALL sie die Ausgabe der PTY, die ein Backend-Aufruf dafür neu zeichnet, während dieses Aufrufs und höchstens 2 s je Aufruf als Neuzeichnen kennzeichnen; ein gescheiterter Aufruf beendet das sofort. Der Verlauf MUST solche Ausgabe nicht speichern, Views MUST sie unverändert erhalten. Übrige Ausgabe SHALL er speichern, auch Neuzeichnen von tmux selbst oder beim Anbinden einer PTY, nicht aber nach einer Größenänderung.

#### Scenario: Neuzeichnen beim Anhängen

- **GIVEN** eine WSL-Session mit Logging, einer angehängten View und gespeicherter Ausgabe „hello“
- **WHEN** eine zweite View anhängt und das angeforderte Neuzeichnen den Bildschirm in die PTY schreibt
- **THEN** entsteht kein neuer Verlaufseintrag, und beide Views erhalten das Neuzeichnen als Ausgabe

#### Scenario: Ausgabe nach dem Neuzeichnen

- **GIVEN** eine Session, deren angefordertes Neuzeichnen beendet ist
- **WHEN** das Programm „after“ ausgibt
- **THEN** speichert der Verlauf „after“ hinter der früheren Ausgabe

#### Scenario: Gescheitertes Neuzeichnen

- **GIVEN** eine Session, deren Neuzeichnen beim Anhängen zweimal scheitert
- **WHEN** danach Ausgabe eintrifft
- **THEN** speichert der Verlauf sie

#### Scenario: Wiederholung nach gescheitertem Aufruf

- **GIVEN** ein Neuzeichnen, dessen erster Backend-Aufruf scheitert
- **WHEN** die Wiederholung den Bildschirm in die PTY schreibt
- **THEN** speichert der Verlauf diese Bytes nicht, die Ausgabe danach aber schon

#### Scenario: Obergrenze je Aufruf

- **GIVEN** ein Backend-Aufruf zum Neuzeichnen, der länger als 2 s dauert (WSL hängt)
- **WHEN** nach diesen 2 s Ausgabe eintrifft
- **THEN** speichert der Verlauf sie

#### Scenario: Wiederanbinden während des Neuzeichnens

- **GIVEN** ein laufender Backend-Aufruf zum Neuzeichnen, während dessen der tmux-Client verloren geht und die Registry eine neue PTY anbindet
- **WHEN** die neue PTY Ausgabe liefert, bevor dieser Aufruf endet
- **THEN** speichert der Verlauf sie, auch den Bildschirm, den tmux beim Anbinden zeichnet; erst die Ausgabe der neuen PTY während eines folgenden Aufrufs wird nicht gespeichert

#### Scenario: Ohne angefordertes Neuzeichnen

- **GIVEN** eine Session, an die gerade keine View mit Snapshot des Backends anhängt (etwa eine Windows-Session oder tmux zeichnet von selbst neu)
- **WHEN** Ausgabe eintrifft
- **THEN** speichert der Verlauf sie wie jede andere Ausgabe
