## RENAMED Requirements

- FROM: `### Requirement: Bekannte Grenze: Neuzeichnen beim Anhängen`
- TO: `### Requirement: Neuzeichnen beim Anhängen nicht speichern`

## MODIFIED Requirements

### Requirement: Neuzeichnen beim Anhängen nicht speichern

Fordert die Registry nach dem Anhängen einer View ein Neuzeichnen an, SHALL sie jede Ausgabe der Session, die vom Anfordern bis zum Ende dieses Neuzeichnens (samt Wiederholung und zusammengefasstem Folge-Neuzeichnen) eintrifft, als Neuzeichnen kennzeichnen. Der Verlauf MUST solche Ausgabe nicht speichern; Views MUST sie unverändert erhalten. Alle übrige Ausgabe SHALL der Verlauf wie bisher speichern, auch Neuzeichnen, das tmux von selbst auslöst.

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

#### Scenario: Ohne angefordertes Neuzeichnen

- **GIVEN** eine Session, an die gerade keine View mit Snapshot des Backends anhängt (etwa eine Windows-Session oder tmux zeichnet von selbst neu)
- **WHEN** Ausgabe eintrifft
- **THEN** speichert der Verlauf sie wie jede andere Ausgabe
