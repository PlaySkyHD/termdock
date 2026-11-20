## MODIFIED Requirements

### Requirement: Pipe-Name pro Konto

Der Pipe-Name SHALL `\\.\pipe\termdock-core-<benutzer>-<hash>` lauten. `<benutzer>` ist der für Pipe-Namen bereinigte Benutzername, `<hash>` sind 12 Hex-Zeichen von SHA-256 über `<Domäne>\<Benutzername>` im Rohzustand (Domäne aus `USERDOMAIN`, sonst Rechnername). Konten, deren bereinigte Namen gleich sind oder die sich nur in der Domäne unterscheiden, MUST verschiedene Pipes haben.

#### Scenario: Konten mit gleichem bereinigtem Namen

- **GIVEN** die Konten `PC\Jörg` und `PC\Jürg` sowie `DOMAIN\bob` und `PC\bob`
- **WHEN** ihre Pipe-Namen gebildet werden
- **THEN** sind alle Namen verschieden

#### Scenario: Name des laufenden Kontos

- **GIVEN** ein Prozess ohne ausdrücklichen Benutzer und ohne Domäne
- **WHEN** er den Standardnamen bildet
- **THEN** besteht der Name aus dem bereinigten Benutzernamen des Prozesses und dem Hash über dessen `USERDOMAIN` (oder Rechnernamen) und Benutzernamen, und ein anderer Benutzername ergibt einen anderen Namen

### Requirement: Zugriffsrechte der Pipe

Kein Konto außer dem Benutzer des Core, SYSTEM und den Administratoren SHALL Schreibzugriff auf die Pipe haben. Fremde Konten dürfen die Pipe höchstens lesend öffnen (Windows gewährt Everyone und Anonymous Lesezugriff auf Pipes ohne eigenen Sicherheitsdeskriptor); sie können keine Anfrage senden und erhalten keine Events oder Nutzdaten. Weitere Trustees MUST nicht in der DACL stehen. Ein Windows-Test MUST die DACL der erzeugten Pipe prüfen.

#### Scenario: DACL der Core-Pipe

- **GIVEN** ein gestarteter Core auf einer Pipe (Windows)
- **WHEN** die DACL der Pipe gelesen wird
- **THEN** hat der aktuelle Benutzer Vollzugriff, kein anderer Trustee außer SYSTEM und Administratoren hat Schreibrecht, außer Everyone und Anonymous steht kein weiterer Trustee darin, und Besitzer ist der Benutzer

#### Scenario: Core mit erhöhtem Token

- **GIVEN** ein Core, der mit erhöhtem Administrator-Token läuft (z. B. GitHub-Runner)
- **WHEN** die DACL der Pipe gelesen wird
- **THEN** hält statt des Benutzers die Gruppe Administratoren den Vollzugriff (und darf Besitzer sein), und kein anderer Trustee hat Schreibrecht
