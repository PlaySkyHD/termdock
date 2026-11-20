## MODIFIED Requirements

### Requirement: Neustart

`restart` SHALL eine Session in `Exited` oder `Interrupted` unter derselben ID über `Starting` neu starten. Besteht die Backend-Session noch, MUST der Core sich anbinden statt einen zweiten Prozess zu starten. Views und Schreiber bleiben. Der Rohdaten-Puffer MUST erst geleert werden, wenn die neue PTY angebunden ist; erste Ausgabe des neuen Laufs SHALL die Trennzeile `--- Neu gestartet <ISO-Zeit> ---` sein. Ein zweiter Aufruf während des Starts MUST `invalid_state` ergeben.

#### Scenario: Neustart schlägt fehl

- **GIVEN** eine `Exited`-Session mit bisheriger Ausgabe und ein Backend, dessen Start fehlschlägt
- **WHEN** sie neu gestartet wird und danach eine View angehängt wird
- **THEN** ist die Session `Interrupted` und der Snapshot der View enthält die bisherige Ausgabe

#### Scenario: Neustart nach Prozessende

- **GIVEN** eine Session im Zustand `Exited` mit einer angehängten View
- **WHEN** sie neu gestartet wird
- **THEN** behält sie ihre ID, das Backend hat einen neuen Start erhalten und der Zustand ist `Running`

#### Scenario: Neustart bei noch vorhandener Backend-Session

- **GIVEN** eine `Interrupted`-Session, deren Backend-Session noch existiert
- **WHEN** sie neu gestartet wird
- **THEN** bindet sich der Core wieder an, ohne einen neuen Start auszulösen

#### Scenario: Trennzeile

- **GIVEN** eine `Exited`-Session mit Ausgabe `alt` und einer angehängten View, die Uhr steht auf `2026-11-20T08:00:00.000Z`
- **WHEN** sie neu gestartet wird
- **THEN** erhält die View als erste Ausgabe `\r\n--- Neu gestartet 2026-11-20T08:00:00.000Z ---\r\n`, der Rohdaten-Puffer beginnt damit, und erst danach folgt die Ausgabe der neuen PTY

#### Scenario: Zwei Neustarts gleichzeitig

- **GIVEN** eine `Interrupted`-Session
- **WHEN** `restart` zweimal aufgerufen wird, ohne auf den ersten zu warten
- **THEN** scheitert der zweite mit `invalid_state`, und das Backend hat genau einen neuen Start erhalten
