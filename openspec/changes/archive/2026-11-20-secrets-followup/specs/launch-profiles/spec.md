## MODIFIED Requirements

### Requirement: Keine Geheimnisse in Profilen

Der Core SHALL beim Anlegen und Ändern eines Profils jeden Eintrag von `launch.env` mit `bad_request` ablehnen, dessen Name auf `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`, `CREDENTIAL(S)`, `_PAT`, `_PASS` oder `_KEY` endet (Groß- und Kleinschreibung egal, `PUBLIC_KEY` ausgenommen) oder dessen Wert eine URL mit Passwort ist (`scheme://user:pass@host`). Die Meldung MUST den Schlüssel nennen, nie den Wert.

#### Scenario: Geheimnis in der Umgebung

- **GIVEN** ein Core ohne Profile
- **WHEN** ein Client ein Profil mit `launch.env { GITHUB_TOKEN: "abc" }` anlegt, oder ein bestehendes Profil mit `launch.env { NPM_TOKEN: "abc" }` ändert
- **THEN** antwortet der Core mit `bad_request`, die Meldung nennt den Schlüssel und nicht `abc`, und nichts wird gespeichert; `LANG` oder `TOKENS_PER_MIN` sind erlaubt

#### Scenario: Weitere Schlüsselformen und URL mit Passwort

- **GIVEN** ein Core ohne Profile
- **WHEN** ein Client ein Profil mit `STRIPE_KEY`, `GITHUB_PAT`, `DB_PASS` oder `DATABASE_URL: "postgres://app:td-test-secret-0000@db.example.invalid/x"` anlegt
- **THEN** antwortet der Core jeweils mit `bad_request`, die Meldung nennt den Schlüssel und nicht den Wert

#### Scenario: Harmlose Einträge

- **GIVEN** ein Core ohne Profile
- **WHEN** ein Client ein Profil mit `KEYBOARD`, `KEYMAP`, `SSH_AUTH_SOCK`, `PATH`, `XDG_RUNTIME_DIR`, `GPG_PUBLIC_KEY` und `DATABASE_URL: "postgres://db.example.invalid:5432/x"` anlegt
- **THEN** speichert der Core das Profil
