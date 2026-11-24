## MODIFIED Requirements

### Requirement: Standardverzeichnis für neue Sessions

Der Core SHALL eine reine Funktion `defaultCwd` bereitstellen, die für das Ziel-Backend einer Session ohne `cwd` das erste gesetzte aus Projektpfad, `defaultCwd` des Workspace und `defaultCwd` der Einstellungen liefert, dessen Syntax zum Backend passt (wie die Pfadprüfung der Projekte), sonst `~` (WSL: Home der Distro, `windows`: Benutzerordner). Die Einstellungen MUST als Parameter kommen; die Funktion MUST weder Dateisystem noch Repository lesen.

#### Scenario: Rangfolge

- **GIVEN** ein Projekt mit Pfad `/p`, ein Workspace mit `defaultCwd` `/w` und Einstellungen mit `defaultCwd` `/s`
- **WHEN** `defaultCwd` mit allen dreien, danach ohne Projekt, ohne Workspace-Wert und ohne Einstellung aufgerufen wird
- **THEN** liefert sie nacheinander `/p`, `/w`, `/s` und `~`

#### Scenario: Syntax passt nicht zum Backend

- **GIVEN** ein Projekt mit Pfad `C:dev`, ein Workspace mit `defaultCwd` `D:w` und Einstellungen mit `defaultCwd` `/s`
- **WHEN** `defaultCwd` für das Backend `wsl` aufgerufen wird
- **THEN** liefert sie `/s`; ohne die Einstellung `~`, für `windows` mit denselben Werten `C:dev`
