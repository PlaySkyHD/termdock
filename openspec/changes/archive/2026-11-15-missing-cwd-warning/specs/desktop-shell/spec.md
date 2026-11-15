## ADDED Requirements

### Requirement: Hinweis bei fehlendem Arbeitsverzeichnis

Hat eine laufende Session die Warnung `cwd_missing`, SHALL ihr Pane oben einen Hinweis zeigen: „Verzeichnis <path> fehlt in <distro> – die Session läuft im Wurzelverzeichnis /.“ Er MUST keine Eingabe blockieren und sich mit „Hinweis schließen“ schließen lassen; geschlossen bleibt er in diesem Fenster bis zum nächsten Start der Session. Unbekannte Codes zeigt das Pane nicht. Die Screenshot-Szene nimmt Hinweis und geschlossenen Hinweis auf.

#### Scenario: Hinweis im Pane

- **GIVEN** eine Session `API` mit `cwd` `/srv/api`, das in `Ubuntu` fehlt
- **WHEN** ihr Pane angezeigt wird
- **THEN** steht oben „Verzeichnis /srv/api fehlt in Ubuntu – die Session läuft im Wurzelverzeichnis /.“, und `pwd` im Terminal zeigt `/`

#### Scenario: Schließen

- **GIVEN** der Hinweis ist sichtbar
- **WHEN** der Nutzer „Hinweis schließen“ wählt
- **THEN** verschwindet er, das Terminal nimmt weiter Eingaben an, und Wechsel zwischen `Running` und `Detached` desselben Laufs bringen ihn nicht zurück

#### Scenario: Neuer Start

- **GIVEN** ein geschlossener Hinweis
- **WHEN** die Session wieder `Starting` wird
- **THEN** zeigt das Pane die Warnungen des neuen Laufs wieder

#### Scenario: Ohne Warnung

- **GIVEN** eine Session in `/tmp`, eine beendete Session oder eine Warnung mit unbekanntem Code
- **WHEN** ihr Pane angezeigt wird
- **THEN** zeigt es keinen Hinweis

#### Scenario: Warnungen über die Brücke

- **GIVEN** ein `session.stateChanged` mit `warnings`, auch eines, das vor der ersten Liste ankommt
- **WHEN** der Main es weiterreicht und das Fenster es anwendet
- **THEN** hat die Session im Store diese Warnungen; ein Wechsel ohne `warnings` entfernt sie

#### Scenario: Screenshot-Szene

- **WHEN** der Screenshot-Modus läuft
- **THEN** entstehen `70-cwd-missing-warning.png` (Hinweis, `cwd=/` im Terminal) und `71-cwd-warning-dismissed.png` (geschlossen, weitere Eingabe), und eine Session in `/tmp` zeigt keinen Hinweis; mit `--scenes cwd` läuft die Szene allein

## MODIFIED Requirements

### Requirement: Screenshot-Modus wählt Szenengruppen

Mit `--scenes <gruppe,…>` SHALL der Screenshot-Modus nur die genannten Szenengruppen aufnehmen (`scenario`, `sidebar`, `tabs`, `snap`, `restore`, `quit`, `search`, `settings`, `cwd`), in fester Reihenfolge; ohne die Option laufen alle. Jede Gruppe SHALL ihren Aufbau selbst mitbringen. Ein unbekannter Name oder eine leere Liste SHALL die App vor dem Start des Cores mit Code 1 beenden und die gültigen Namen nennen.

#### Scenario: Eine Gruppe allein

- **WHEN** die App mit `--screenshot <dir> --scenes search` startet
- **THEN** enthält `<dir>` nur die Bilder der Suche, und der Lauf endet mit Code 0

#### Scenario: Unbekannter Name

- **WHEN** die App mit `--screenshot <dir> --scenes search,nope` startet
- **THEN** startet kein Core, die Meldung nennt `nope` und die gültigen Gruppen, und die App endet mit Code 1
