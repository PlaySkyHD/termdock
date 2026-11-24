## ADDED Requirements

### Requirement: PTYs vor den Sessions beim Shutdown mit Stop

Bei `core.shutdown { stopSessions: true }` SHALL der Core je Session zuerst ihre PTY schließen und auf deren Prozessende warten, die PTYs nacheinander. Erst danach SHALL er die Backend-Session beenden; die Backend-Sessions dürfen dabei gleichzeitig enden. Scheitert das Beenden einer Backend-Session, MUST diese Session `Interrupted` werden; die Antwort nennt sie als nicht beendet.

#### Scenario: Reihenfolge

- **GIVEN** zwei laufende Sessions
- **WHEN** der Core beide mit Stop beendet
- **THEN** ist jede PTY geschlossen, bevor das Backend ihre Session beendet, und keine Backend-Session wird beendet, solange ihre PTY noch schließt

#### Scenario: Keine gleichzeitigen Enden

- **GIVEN** zehn Sessions, deren PTYs `cmd.exe` über den Pfad des Core ausführen
- **WHEN** der Core alle mit Stop beendet
- **THEN** läuft keiner dieser Prozesse mehr, wenn das Backend die zugehörige Session beendet, und alle Sessions sind `Exited`

#### Scenario: Backend scheitert

- **GIVEN** zwei laufende Sessions, bei einer scheitert das Beenden der Backend-Session
- **WHEN** der Core beide mit Stop beendet
- **THEN** ist diese Session `Interrupted` und die andere `Exited`
