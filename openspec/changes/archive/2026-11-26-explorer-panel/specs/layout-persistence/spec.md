## ADDED Requirements

### Requirement: Explorer im Layout-Fenster

Seit Protokoll 1.9 SHALL ein Fenster im `LayoutDocument` zusätzlich optional `explorerVisible` (Boolean) und `explorerWidth` (Zahl größer 0) tragen dürfen: Sichtbarkeit und Breite des Explorer-Panels. Der Core SHALL sie unverändert speichern und liefern. Lehnt ein Core 1.8 die Felder mit `bad_request` ab, SHALL der Main das Layout ohne sie speichern.

#### Scenario: Explorer des Fensters

- **GIVEN** ein Fenster mit `explorerVisible: false` und `explorerWidth: 344`
- **WHEN** es gespeichert und gelesen wird
- **THEN** sind beide Felder unverändert; `explorerVisible: "no"` oder `explorerWidth: 0` ergeben `bad_request`

#### Scenario: Älterer Core

- **GIVEN** ein Core, der `explorerVisible` mit `bad_request` ablehnt
- **WHEN** der Main das Layout speichert
- **THEN** speichert er es ein zweites Mal ohne die Felder des Explorers, und Tabs und Panes bleiben erhalten
