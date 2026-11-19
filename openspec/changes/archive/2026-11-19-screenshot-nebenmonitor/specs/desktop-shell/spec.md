## ADDED Requirements

### Requirement: Screenshot-Fenster auf einem Nebenmonitor

Im Screenshot-Modus SHALL ein Fenster ohne gespeicherte Position 40 px innerhalb des Arbeitsbereichs des ersten Monitors öffnen, der nicht der Hauptmonitor ist; ohne Nebenmonitor auf dem Hauptmonitor. `TERMDOCK_SCREENSHOT_DISPLAY` SHALL das überschreiben: `primary` oder die 1-basierte Nummer eines Monitors; eine Nummer ohne Monitor gilt wie keine Angabe. Der normale Start MUST unverändert bleiben.

#### Scenario: Drei Monitore

- **GIVEN** `screen.getAllDisplays()` liefert Nebenmonitor A, Nebenmonitor B und den Hauptmonitor in dieser Reihenfolge
- **WHEN** ein Screenshot-Lauf ohne `TERMDOCK_SCREENSHOT_DISPLAY` ein Fenster öffnet
- **THEN** liegt es 40 px innerhalb des Arbeitsbereichs von Nebenmonitor A

#### Scenario: Hauptmonitor gewählt

- **WHEN** ein Screenshot-Lauf mit `TERMDOCK_SCREENSHOT_DISPLAY=primary` ein Fenster öffnet
- **THEN** liegt es 40 px innerhalb des Arbeitsbereichs des Hauptmonitors
