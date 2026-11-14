## MODIFIED Requirements

### Requirement: Archivieren

`archive` SHALL eine Session in `Running`, `Detached`, `Exited` oder `Interrupted` nach `Archived` bringen. Läuft der Prozess noch oder existiert die Backend-Session noch, MUST er zuerst über das Backend beendet werden. Scheitert die Existenzprüfung oder das Beenden im Backend, MUST der Aufruf mit `backend_unavailable` fehlschlagen und die Session nicht `Archived` werden. Alle Views werden getrennt. Der Verlauf auf der Platte MUST erhalten bleiben. `Archived` ist endgültig.

#### Scenario: Existenzprüfung scheitert

- **GIVEN** eine `Interrupted`-Session und ein Backend, dessen Existenzprüfung fehlschlägt
- **WHEN** sie archiviert wird
- **THEN** schlägt der Aufruf mit `backend_unavailable` fehl und die Session bleibt `Interrupted`

#### Scenario: Laufende Session archivieren

- **GIVEN** eine Session im Zustand `Running` mit gespeichertem Verlauf
- **WHEN** sie archiviert wird
- **THEN** hat das Backend den Prozess beendet, die Session ist `Archived`, hat keine Views und keinen Schreiber, und ihr Verlauf ist nicht entfernt

#### Scenario: Neustart einer archivierten Session

- **GIVEN** eine Session im Zustand `Archived`
- **WHEN** sie neu gestartet werden soll
- **THEN** schlägt der Aufruf mit `invalid_state` fehl

## ADDED Requirements

### Requirement: Session ändern

`update` SHALL Name, Workspace und Verlauf-Schalter einer Session in jedem Zustand ändern und die Änderungszeit setzen. Ein fehlendes Feld MUST unverändert bleiben, `workspaceId: null` MUST die Session gruppenlos machen. Der Prozess, der Zustand und die Views MUST unberührt bleiben. Ein leerer oder zu langer Name MUST mit `bad_request` abgelehnt werden, eine unbekannte Session mit `not_found`, eine Session, die gerade gelöscht wird, mit `invalid_state`.

#### Scenario: Laufende Session umbenennen

- **GIVEN** eine Session im Zustand `Detached`
- **WHEN** sie in `build` umbenannt wird
- **THEN** heißt sie `build`, ist weiter `Detached` mit derselben PTY, und das Backend hat weder beendet noch neu gestartet

#### Scenario: Nach gruppenlos und zurück verschieben

- **GIVEN** eine Session im Workspace `w1`
- **WHEN** sie mit `workspaceId: null` und danach mit `workspaceId: "w2"` geändert wird
- **THEN** hat sie zuerst keinen Workspace und danach `w2`

#### Scenario: Ungültiger Name

- **GIVEN** eine Session `shell`
- **WHEN** sie in einen Namen aus Leerzeichen umbenannt werden soll
- **THEN** schlägt der Aufruf mit `bad_request` fehl und sie heißt weiter `shell`

### Requirement: Session löschen

`delete` SHALL nur Sessions in `Exited`, `Interrupted` oder `Archived` löschen, sonst `invalid_state`. Bei `Interrupted` MUST eine lebende Backend-Session zuerst beendet werden; scheitert die Prüfung bei verfügbarem Backend, MUST es `backend_unavailable` ergeben. Dann MUST der Core Verlauf und Zeile entfernen, die Views trennen und die Session vergessen. Scheitert ein Schritt, MUST die Session mit Views bleiben. Währenddessen MUST Anhängen und jeder Lifecycle-Aufruf `invalid_state` ergeben.

#### Scenario: Laufende Session löschen

- **GIVEN** eine Session im Zustand `Running`
- **WHEN** sie gelöscht werden soll
- **THEN** schlägt der Aufruf mit `invalid_state` fehl, und Prozess, Verlauf und gespeicherte Session bleiben

#### Scenario: Beendete Session löschen

- **GIVEN** eine `Exited`-Session mit zwei Views, Verlauf und gespeicherter Zeile
- **WHEN** sie gelöscht wird
- **THEN** ist ein Schreiberwechsel ohne Schreiber an beide Views gemeldet, Verlauf und Zeile sind entfernt, und die Session ist unbekannt (`not_found`)

#### Scenario: Verbliebene Backend-Session

- **GIVEN** eine `Interrupted`-Session, deren Backend-Session noch existiert
- **WHEN** sie gelöscht wird
- **THEN** hat das Backend die Session beendet und es gibt keine Backend-Session mehr

#### Scenario: Backend nicht erreichbar

- **GIVEN** eine `Interrupted`-Session und ein verfügbares Backend, dessen Existenzprüfung fehlschlägt
- **WHEN** sie gelöscht wird
- **THEN** schlägt der Aufruf mit `backend_unavailable` fehl und Session und Verlauf bleiben

#### Scenario: Backend nicht verfügbar

- **GIVEN** eine `Interrupted`-Session und ein Backend, das nicht verfügbar ist und dessen Existenzprüfung fehlschlägt
- **WHEN** sie gelöscht wird
- **THEN** gelingt das Löschen ohne Beenden im Backend

#### Scenario: Archivierte Session löschen

- **GIVEN** eine `Exited`- oder `Archived`-Session und ein Backend, dessen Existenzprüfung fehlschlagen würde
- **WHEN** sie gelöscht wird
- **THEN** gelingt das Löschen ohne Frage an das Backend

#### Scenario: Aufrufe während des Löschens

- **GIVEN** eine `Exited`-Session, deren Löschen noch läuft
- **WHEN** eine View angehängt, die Session geändert, neu gestartet oder erneut gelöscht werden soll
- **THEN** schlägt jeder Aufruf mit `invalid_state` fehl, und danach ist die Session gelöscht
