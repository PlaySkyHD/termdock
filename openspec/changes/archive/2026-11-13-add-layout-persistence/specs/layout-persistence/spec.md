## Purpose
Legt fest, wie der Core das Layout der Oberfläche (Fenster, Tabs, Split-Panes) speichert: Form und Prüfung des Layout-Dokuments, ein globales Layout mit Revision in der Tabelle `layouts` (ADR 0004) und die Methoden `layout.get` und `layout.save`, damit die Desktop-App es nach einem Neustart wiederherstellen kann.

## ADDED Requirements

### Requirement: Layout-Dokument

Der Vertrag SHALL das Layout als `LayoutDocument` mit Versionsfeld beschreiben: `windows[]` mit `id`, optional `bounds`, `maximized`, `sidebarVisible`, `sidebarWidth`, `tabs[]` (0 bis 64) und `activeTabId` (Pflicht bei vorhandenen Tabs, sonst weggelassen); ein Tab mit `id`, optional `title`, `root` und `activePaneId`; ein `PaneNode` als Blatt (`kind: "pane"`, `id`, `sessionId`) oder Split (`kind: "split"`, `id`, `direction` `row` oder `column`, `children`, `sizes`).

#### Scenario: Gültiges Dokument

- **GIVEN** ein Dokument mit einem Fenster, einem Tab und einem Split aus zwei Panes mit `sizes` `[0.5, 0.5]`
- **WHEN** es geprüft wird
- **THEN** ist es gültig, auch wenn eine `sessionId` keiner Session entspricht

### Requirement: Prüfung des Layouts

Die Prüfung SHALL ein Dokument mit `bad_request` ablehnen, wenn eine ID im Dokument doppelt vorkommt, ein Tab mehr als 4 Panes hat, ein Split weniger als 2 Kinder hat, `sizes` nicht zu den Kindern passt oder nicht etwa 1 ergibt, oder `activeTabId` bzw. `activePaneId` auf kein vorhandenes Element zeigt.

#### Scenario: Fenster ohne Tabs

- **GIVEN** ein Fenster mit `tabs: []` ohne `activeTabId`
- **WHEN** das Dokument geprüft wird
- **THEN** ist es gültig; mit `activeTabId` bei leeren `tabs`, oder ohne `activeTabId` bei vorhandenen Tabs, ist das Ergebnis `bad_request`

### Requirement: Grenzen des Layouts

Die Prüfung SHALL `bad_request` liefern bei mehr als 16 Fenstern, mehr als 64 Tabs je Fenster, Tab-Titeln über 128 Zeichen, IDs und `sessionId` über 64 Zeichen, unbekannten Schlüsseln in Dokument, Fenster, `bounds`, Tab, Pane oder Split und einem Dokument über 256 KiB (UTF-8 von `JSON.stringify`). So bleibt auch die Antwort von `layout.get` unter dem Header-Limit.

#### Scenario: Zu großes Dokument

- **GIVEN** ein Dokument mit 16 Fenstern zu je 64 Tabs mit 64 Zeichen langen IDs
- **WHEN** es geprüft wird
- **THEN** ist das Ergebnis `bad_request`

#### Scenario: Unbekannter Schlüssel

- **GIVEN** ein Tab mit dem zusätzlichen Schlüssel `extra`
- **WHEN** das Dokument geprüft wird
- **THEN** ist das Ergebnis `bad_request` und nennt den Schlüssel

### Requirement: Unbrauchbares gespeichertes Layout

Ist das gespeicherte Dokument kein gültiges JSON oder besteht die Prüfung nicht, SHALL `layout.get` kein `layout`, aber die gespeicherte `revision` liefern und den Grund auf stderr melden. Ein folgendes `layout.save` mit dieser `revision` als `baseRevision` MUST gelingen.

#### Scenario: Beschädigtes Dokument

- **GIVEN** ein gespeichertes Dokument mit Revision 2, das die Prüfung nicht besteht
- **WHEN** ein Client `layout.get` aufruft
- **THEN** enthält die Antwort `revision` 2 ohne `layout`, und `layout.save` mit `baseRevision` 2 liefert Revision 3

#### Scenario: Mehr als vier Panes

- **GIVEN** ein Tab mit fünf Panes
- **WHEN** das Dokument geprüft wird
- **THEN** ist das Ergebnis `bad_request`

#### Scenario: Doppelte ID

- **GIVEN** ein Dokument, in dem ein Tab und eine Pane dieselbe ID tragen
- **WHEN** es geprüft wird
- **THEN** ist das Ergebnis `bad_request` und nennt die ID

#### Scenario: Falsche Größenangaben

- **GIVEN** ein Split mit drei Kindern und zwei `sizes`, oder `sizes` mit Summe 1,5, oder einer Größe 0
- **WHEN** das Dokument geprüft wird
- **THEN** ist das Ergebnis `bad_request`

#### Scenario: Unbekannte aktive ID

- **GIVEN** ein Tab, dessen `activePaneId` in seinem Baum fehlt, oder ein Fenster, dessen `activeTabId` keinen Tab nennt
- **WHEN** das Dokument geprüft wird
- **THEN** ist das Ergebnis `bad_request`

### Requirement: Layout speichern und lesen

Der Core SHALL ein globales Layout in der Tabelle `layouts` ablegen. `layout.get` MUST `layout` (fehlt, solange nichts gespeichert ist) und `revision` liefern. `layout.save` MUST das Dokument prüfen, speichern und die neue `revision` liefern. Die Revision MUST bei 0 beginnen und mit jedem Speichern um 1 steigen.

#### Scenario: Speichern und Lesen

- **GIVEN** ein Core ohne gespeichertes Layout
- **WHEN** ein Client `layout.get` aufruft, ein gültiges Layout speichert und erneut `layout.get` aufruft
- **THEN** fehlt `layout` zuerst mit `revision` 0, danach liefert `layout.save` die Revision 1 und `layout.get` das Layout unverändert mit Revision 1

#### Scenario: Ungültiges Layout

- **GIVEN** ein Layout mit doppelter ID
- **WHEN** ein Client es mit `layout.save` sendet
- **THEN** antwortet der Core `bad_request` und das gespeicherte Layout bleibt unverändert

### Requirement: Revisionskonflikt

`layout.save` mit `baseRevision`, das nicht der aktuellen Revision entspricht, SHALL mit `invalid_state` scheitern und nichts ändern. Ohne `baseRevision` MUST das Speichern immer gelten.

#### Scenario: Veraltetes baseRevision

- **GIVEN** gespeicherte Revision 2
- **WHEN** ein Client mit `baseRevision` 1 speichert
- **THEN** antwortet der Core `invalid_state`, und `layout.get` liefert weiter Revision 2

### Requirement: Layout übersteht Core-Neustart

Das gespeicherte Layout und seine Revision SHALL nach einem Neustart des Core mit demselben Datenverzeichnis unverändert verfügbar sein. `layout.*` MUST wie andere Anfragen auf den Abgleich beim Start warten.

#### Scenario: Neustart

- **GIVEN** ein gespeichertes Layout mit Revision 3
- **WHEN** der Core beendet und mit demselben Datenverzeichnis neu gestartet wird
- **THEN** liefert `layout.get` dasselbe Dokument mit Revision 3
