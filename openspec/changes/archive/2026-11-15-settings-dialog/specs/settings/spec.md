## ADDED Requirements

### Requirement: Vorgaben für neue Sessions

Legt ein Client eine Session an (direkt oder aus einem Profil), SHALL der Core einem WSL-`LaunchSpec` ohne `distro` die Einstellung `defaultDistro` und einem Windows-`LaunchSpec` ohne `shell` die Einstellung `defaultShell` geben, gelesen beim Anlegen. Ein gesetztes `distro` oder `shell` MUST unverändert bleiben. Ohne Einstellung SHALL das Backend wie bisher die Standard-Distro von WSL auflösen. Bestehende Sessions MUST unverändert bleiben.

#### Scenario: Distribution aus den Einstellungen

- **GIVEN** gespeichert ist `defaultDistro: "Debian"`
- **WHEN** ein Client `session.create { name: "a", launch: { backend: "wsl", cwd: "/" } }` aufruft
- **THEN** hat die neue Session `launch.distro` `Debian`

#### Scenario: Ausdrückliche Distribution gewinnt

- **GIVEN** gespeichert ist `defaultDistro: "Debian"`
- **WHEN** ein Client eine Session mit `launch.distro: "Ubuntu"` oder aus einem Profil mit `distro: "Ubuntu"` anlegt
- **THEN** hat die Session `launch.distro` `Ubuntu`

#### Scenario: Profil ohne Distribution

- **GIVEN** gespeichert ist `defaultDistro: "Debian"` und ein WSL-Profil ohne `distro`
- **WHEN** ein Client `session.create { name: "a", profileId }` aufruft
- **THEN** hat die Session `launch.distro` `Debian`, das Profil selbst bleibt ohne `distro`

#### Scenario: Shell aus den Einstellungen

- **GIVEN** gespeichert ist `defaultShell: "cmd"`
- **WHEN** ein Client eine Windows-Session ohne `shell` anlegt
- **THEN** hat sie `launch.shell` `cmd`; eine WSL-Session bekommt keine `shell`
