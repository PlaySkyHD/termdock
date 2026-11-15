## ADDED Requirements

### Requirement: Fokus nach dem Archivieren

Nach erfolgreichem Archivieren (Menü, Tastatur, Ziehen aufs Archiv) SHALL die archivierte Zeile im Archiv den Tastaturfokus haben, nicht der Knopf „Neue WSL-Session“. Ist das Archiv zugeklappt, SHALL es dafür aufklappen. Abbrechen und Esc im Bestätigungsdialog geben den Fokus an die auslösende Zeile zurück; bei einem Fehler des Core bleibt der Dialog offen.

#### Scenario: Archivieren per Tastatur

- **GIVEN** eine laufende Session hat in der Sidebar den Fokus, und das Archiv ist zugeklappt
- **WHEN** der Benutzer über das Menü „Archivieren“ wählt und den Dialog bestätigt
- **THEN** klappt das Archiv auf, und die archivierte Zeile darin hat den Fokus

#### Scenario: Archivieren abbrechen

- **GIVEN** der Bestätigungsdialog zum Archivieren ist offen
- **WHEN** der Benutzer Esc drückt
- **THEN** bleibt die Session unverändert, das Archiv zu, und die auslösende Zeile hat den Fokus
