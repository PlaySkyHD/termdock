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
- **THEN** entstehen `70-cwd-missing-warning.png` (Hinweis, `cwd=/` im Terminal) und `71-cwd-warning-dismissed.png` (geschlossen, weitere Eingabe), und eine Session in `/tmp` zeigt keinen Hinweis
