## ADDED Requirements

### Requirement: Backend-Vorgaben beim Start festhalten

Vor dem Start oder Neustart einer Session SHALL der Core fehlende Vorgaben des `LaunchSpec` vom Backend auflösen lassen (WSL: konfigurierte oder Standard-Distro) und den aufgelösten `LaunchSpec` speichern, bevor er das Backend startet. Alle weiteren Backend-Aufrufe der Session MUST ihn verwenden. Scheitert das Auflösen, gilt der Start als gescheitert.

#### Scenario: Distro fehlt beim Anlegen

- **GIVEN** ein WSL-Backend mit Standard-Distro `Ubuntu`
- **WHEN** eine Session ohne `distro` angelegt wird
- **THEN** hat das Backend den Start mit `distro` `Ubuntu` erhalten und der gespeicherte `LaunchSpec` nennt `Ubuntu`

#### Scenario: Auflösen scheitert

- **GIVEN** ein Backend, dessen Auflösen fehlschlägt
- **WHEN** eine Session angelegt wird
- **THEN** schlägt der Aufruf mit `backend_unavailable` fehl, die Session ist `Interrupted` und das Backend hat keinen Start erhalten

### Requirement: Wiederanbinden nach verlorenem Client

Endet die PTY einer Session in `Running` oder `Detached` ohne Exit-Code, SHALL der Core prüfen, ob die Backend-Session noch existiert, und eine neue PTY anhängen; Zustand, Views und Schreiber MUST erhalten bleiben. Scheitert das, MUST er es nach Wartezeiten erneut versuchen, höchstens dreimal; ein kurz nach dem Anhängen wieder verlorener Client zählt zu denselben Versuchen. Start, Neustart und Abgleich MUST das volle Budget zurückgeben.

#### Scenario: Client geht verloren, Session lebt

- **GIVEN** eine Session in `Running` mit Schreiber A, deren Backend-Session weiterlebt
- **WHEN** die PTY ohne Exit-Code endet
- **THEN** hat der Core sich neu angehängt, die Session ist `Running`, A ist Schreiber und Eingaben von A erreichen die neue PTY

#### Scenario: Anhängen scheitert vorübergehend

- **GIVEN** eine Session in `Detached`, deren Backend-Session weiterlebt, und ein Backend, dessen nächstes Anhängen fehlschlägt
- **WHEN** die PTY ohne Exit-Code endet
- **THEN** gelingt der zweite Versuch und die Session ist `Detached`

#### Scenario: Client geht immer wieder verloren

- **GIVEN** eine Session, deren neu angehängte PTY jedes Mal sofort ohne Exit-Code endet
- **WHEN** die PTY ohne Exit-Code endet
- **THEN** ist die Session nach drei Versuchen `Interrupted`

#### Scenario: Neustart gibt das Budget zurück

- **GIVEN** eine Session, die nach drei verbrauchten Versuchen `Interrupted` wurde und danach neu gestartet ist
- **WHEN** ihre PTY ohne Exit-Code endet
- **THEN** hängt der Core sich erneut an und die Session ist `Detached`

### Requirement: Arbeit während des Wiederanbindens

Solange der Core eine Session wieder anbindet, MUST er `restart` mit `invalid_state` ablehnen. `kill` und `archive` MUST das Wiederanbinden abbrechen, eine laufende Backend-Abfrage abwarten und die Backend-Session beenden. Views SHALL sich weiter anhängen und trennen können; nach dem Anhängen der neuen PTY MUST der Zustand `Running` sein, wenn Views angehängt sind, sonst `Detached`.

#### Scenario: Letzte View trennt sich während des Wiederanbindens

- **GIVEN** eine Session in `Running` mit einer View, deren PTY ohne Exit-Code endete und deren neues Anhängen noch läuft
- **WHEN** die View getrennt wird und das Anhängen danach gelingt
- **THEN** ist die Session `Detached`

#### Scenario: Beenden während des Wiederanbindens

- **GIVEN** eine Session, deren PTY ohne Exit-Code endete und deren Wiederanbinden noch läuft
- **WHEN** `kill` aufgerufen wird
- **THEN** hat das Backend die Session beendet, keine neue PTY wurde angehängt und die Session ist `Exited`

### Requirement: Registry freigeben

Beim Beenden des Core ohne Stop SHALL die Registry alle PTYs lösen, ohne Zustände zu ändern, zu speichern oder Ereignisse zu melden. Laufende Starts, Wiederanbindungen und der Abgleich MUST danach nichts mehr ändern oder speichern; eine danach noch gelieferte PTY MUST sofort gelöst werden.

#### Scenario: Freigeben mit laufender Session

- **GIVEN** eine Session in `Running`
- **WHEN** die Registry freigegeben wird
- **THEN** ist ihre PTY gelöst, das Backend hat die Session nicht beendet und der gespeicherte Zustand ist `Running`

#### Scenario: Start scheitert nach dem Freigeben

- **GIVEN** eine Session, deren Start noch läuft
- **WHEN** die Registry freigegeben wird und der Start danach scheitert
- **THEN** schlägt der Aufruf mit `invalid_state` fehl, kein Ereignis wurde gemeldet und der gespeicherte Zustand ist `Starting`

## MODIFIED Requirements

### Requirement: Ende der PTY

Endet die PTY einer laufenden Session mit Exit-Code, SHALL die Session `Exited` werden und den Exit-Code speichern. Endet sie ohne Exit-Code und existiert die Backend-Session nicht mehr oder scheitert das Wiederanbinden, MUST die Session `Interrupted` werden. Angehängte Views bleiben angehängt.

#### Scenario: Prozess endet selbst

- **GIVEN** eine laufende Session
- **WHEN** die PTY mit Exit-Code 0 endet
- **THEN** ist die Session `Exited` mit letztem Exit-Code 0

#### Scenario: Unerwartetes PTY-Ende

- **GIVEN** eine Session im Zustand `Running` oder `Detached`, deren Backend-Session nicht mehr existiert
- **WHEN** die PTY ohne Exit-Code endet
- **THEN** ist die Session `Interrupted`
