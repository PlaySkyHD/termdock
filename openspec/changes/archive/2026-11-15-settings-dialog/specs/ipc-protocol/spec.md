## ADDED Requirements

### Requirement: WSL-Distributionen im Vertrag

Protokoll 1.4 SHALL die Methode `wsl.distros` ohne Parameter (unbekannte Felder MUST `bad_request` ergeben) enthalten. Das Ergebnis SHALL `{ distros, defaultDistro?, unavailable? }` sein: `distros` höchstens 64 Namen wie Profilnamen (1 bis 128 Zeichen, nicht nur Leerzeichen), `defaultDistro` einer davon, `unavailable` ein Text von 1 bis 512 Zeichen. Weder Anfrage noch Antwort tragen Nutzdaten.

#### Scenario: Gültige Antwort

- **GIVEN** eine Antwort `{ distros: ["Ubuntu", "Debian"], defaultDistro: "Ubuntu" }` auf `wsl.distros`
- **WHEN** sie geparst wird
- **THEN** ist sie gültig, ebenso `{ distros: [], unavailable: "wsl.exe fehlt" }`

#### Scenario: Ungültige Antwort

- **GIVEN** eine Antwort mit 65 Namen, mit einem leeren Namen oder mit `defaultDistro: "Arch"`, das nicht in `distros` steht
- **WHEN** sie geparst wird
- **THEN** ist das Ergebnis `bad_request`

#### Scenario: Unbekanntes Feld in der Anfrage

- **GIVEN** eine Anfrage `wsl.distros { all: true }`
- **WHEN** sie geparst wird
- **THEN** ist das Ergebnis `bad_request`

#### Scenario: Version

- **WHEN** ein Client die Protokollversion liest
- **THEN** ist sie `1.4`, und ein Client mit `1.3` wird weiter angenommen
