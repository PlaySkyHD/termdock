## MODIFIED Requirements

### Requirement: Keine Geheimnisse in gespeicherten Sessions

Der Core SHALL `session.create` mit `bad_request` ablehnen, wenn ein Eintrag von `launch.env` nach der Regel der Profile ein Geheimnis ist (Name auf `TOKEN`, `_KEY`, `_PAT` und Co. am Ende, oder Wert als URL mit Passwort), auch mit `profileId`, bevor er etwas speichert oder startet. Die Meldung MUST den Schlüssel nennen, nie den Wert. Ein Umgebungswert MUST in der Datenbank nur in der `env`-Spalte des Profils oder der Session stehen, in die der Nutzer ihn eingetragen hat.

#### Scenario: Geheimnis in einer eigenen Session

- **GIVEN** ein Core mit einem Profil ohne Umgebung
- **WHEN** ein Client `session.create` mit `launch.env { GITHUB_TOKEN: "td-test-secret-0000" }` sendet, ohne und mit `profileId`
- **THEN** antwortet der Core mit `bad_request`, die Meldung nennt `GITHUB_TOKEN` und nicht den Wert, keine Session ist gespeichert und das Backend hat nichts gestartet; `LANG` und `TOKENS_PER_MIN` sind erlaubt

#### Scenario: Umgebungswert in der Datenbank

- **GIVEN** ein Profil mit `launch.env { TD_TEST_VALUE: "td-test-secret-0000" }` und daraus gestartete, gescheiterte und abgelehnte Sessions
- **WHEN** alle Zellen aller Tabellen der Datenbank gelesen werden
- **THEN** steht der Wert nur in `launch_profiles.env` und `sessions.env`, und kein anderer Dateiinhalt im Datenordner enthält ihn

#### Scenario: Weitere Schlüsselformen in einer Session

- **GIVEN** ein Core ohne Sessions
- **WHEN** ein Client `session.create` mit `launch.env { STRIPE_KEY: "td-test-secret-0000" }` oder `{ DATABASE_URL: "postgres://app:td-test-secret-0000@db.example.invalid/x" }` sendet
- **THEN** antwortet der Core mit `bad_request` und nennt den Schlüssel, nicht den Wert

## ADDED Requirements

### Requirement: Altbestand ohne Geheimnisse

Die Migration auf Schema-Version 4 SHALL aus `sessions.env` jeden Eintrag entfernen, den die Geheimnis-Regel erkennt, und `env` auf `NULL` setzen, wenn nichts bleibt. Je entferntem Eintrag MUST der Core eine Warnung mit Session-ID und Schlüssel in `core.log` schreiben, nie mit dem Wert. Andere Einträge und Zeilen mit unlesbarem JSON MUST unverändert bleiben.

#### Scenario: Session aus der Zeit vor #146

- **GIVEN** eine Datenbank der Version 3 mit einer Session, deren `env` `{ LANG, GITHUB_TOKEN: "td-test-secret-0000", STRIPE_KEY }` enthält, einer mit nur `{ DATABASE_URL: "postgres://app:td-test-secret-0000@db.example.invalid/x" }` und einer mit `{ KEYBOARD, PATH }`
- **WHEN** der Core die Datenbank öffnet
- **THEN** hat die erste nur noch `LANG`, die zweite `env` `NULL`, die dritte unverändert `KEYBOARD` und `PATH`; der Core warnt je entferntem Schlüssel mit der Session-ID, und der Wert steht in keiner Warnung und nicht mehr in `sessions.env`
