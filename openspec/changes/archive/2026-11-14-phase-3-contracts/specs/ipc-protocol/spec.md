## MODIFIED Requirements

### Requirement: Events

Der Core SHALL Clients über die Events `session.output` (Bytes in den Nutzdaten), `session.stateChanged`, `session.resized`, `view.writerChanged`, `session.created` (seit 1.2) und seit 1.3 `session.updated { session }`, `session.removed { sessionId }`, `workspace.changed { workspaces }`, `profile.changed { profiles }` und `settings.changed { settings }` informieren, jeweils mit vollständigem Objekt bzw. vollständiger Liste. Parser SHALL ihre Daten prüfen; keines der neuen Events trägt Nutzdaten.

#### Scenario: Ausgabe-Event

- **GIVEN** ein `event` `session.output` mit `sessionId` und Nutzdaten
- **WHEN** es geparst wird
- **THEN** liefert der Parser Session und Bytes; ohne Nutzdaten ist das Ergebnis `bad_request`

#### Scenario: Schreiberwechsel ohne Schreiber

- **GIVEN** ein `event` `view.writerChanged` ohne `writerViewId`
- **WHEN** es geparst wird
- **THEN** ist das gültig und bedeutet: aktuell schreibt keine View

#### Scenario: Event für neue Session

- **GIVEN** ein `event` `session.created` mit `data.session` als gültiger `SessionInfo`
- **WHEN** es geparst wird
- **THEN** liefert der Parser die Session; ohne `session`, mit ungültigem Zustand oder mit Nutzdaten ist das Ergebnis `bad_request`

#### Scenario: Events der Phase 3

- **GIVEN** je ein `event` `session.updated`, `session.removed`, `workspace.changed`, `profile.changed` und `settings.changed` mit gültigen Daten
- **WHEN** sie geparst werden
- **THEN** liefert der Parser die Daten; ein fehlendes Feld, ein ungültiges Objekt in der Liste, eine Liste über der Grenze oder Nutzdaten ergeben `bad_request`

### Requirement: Ausgabesequenz im Vertrag

Das Ergebnis von `session.attach` SHALL das optionale Feld `outputSeq` und das Event `session.output` das optionale Feld `seq` tragen, beide nicht negative ganze Zahlen. `seq` ist die Nummer der Ausgabe in ihrer Session; Ausgabe mit `seq` über `outputSeq` ist Live-Ausgabe der neuen View. Parser MUST andere Werte mit `bad_request` ablehnen. Die Protokollversion SHALL `1.3` sein (1.1: Ausgabesequenz, 1.2: `session.created`, 1.3: Phase 3); Clients mit `1.0` bis `1.2` bleiben verträglich.

#### Scenario: Attach-Ergebnis mit Marke

- **GIVEN** eine Antwort auf `session.attach` mit `outputSeq: 7`
- **WHEN** sie geparst wird
- **THEN** ist sie gültig; ohne `outputSeq` ebenfalls, mit `outputSeq: -1` oder `"7"` ist das Ergebnis `bad_request`

#### Scenario: Ausgabe-Event mit Nummer

- **GIVEN** ein `event` `session.output` mit `sessionId`, `seq: 8` und Nutzdaten
- **WHEN** es geparst wird
- **THEN** liefert der Parser Session, Nummer und Bytes; mit `seq: 1.5` ist das Ergebnis `bad_request`

#### Scenario: Version 1.1

- **GIVEN** ein `hello` mit Version `1.0`, `1.1` oder `1.2`
- **WHEN** die Version ausgehandelt wird
- **THEN** ist das Ergebnis erfolgreich und enthält die Core-Version `1.3`

## ADDED Requirements

### Requirement: Typen der Phase 3

Der Vertrag SHALL die Typen `Workspace { id, name, projects, defaultCwd? }`, `Project { id, workspaceId, name, path, backend, distro? }`, `LaunchProfile { id, name, workspaceId?, projectId?, launch, autostart, loggingEnabled }`, `Settings`, `SettingsPatch` und `HistoryHit { sessionId, timestamp, line, offset }` definieren. `distro` MUST bei Projekten nur mit Backend `wsl` erlaubt sein. Projekte eines Workspace MUST dessen `id` als `workspaceId` und eindeutige IDs tragen.

#### Scenario: Workspace mit Projekten

- **GIVEN** eine Antwort auf `workspace.list` mit einem Workspace, der zwei Projekte und `defaultCwd` hat
- **WHEN** sie geparst wird
- **THEN** ist sie gültig; ein Projekt mit Backend `windows` und `distro`, ohne `path`, mit fremder `workspaceId` oder mit doppelter ID ergibt `bad_request`

### Requirement: Methoden der Phase 3

Der Vertrag SHALL die Methoden `workspace.list|create|update|delete`, `project.create|update|delete`, `profile.list|create|update|delete`, `session.update`, `session.archive`, `session.delete`, `settings.get|set` und `history.search` ohne Nutzdaten definieren. `*.create` und `*.update` SHALL das geänderte Objekt liefern, `*.list` die vollständige Liste, `*.delete` und `session.archive` ein leeres Ergebnis. Neue Anfragen MUST unbekannte Felder mit `bad_request` ablehnen.

#### Scenario: Gültige Anfragen der Phase 3

- **GIVEN** für jede Methode der Phase 3 eine Anfrage mit gültigen Parametern
- **WHEN** sie geparst wird
- **THEN** liefert der Parser Methode und Parameter unverändert

#### Scenario: Unbekanntes Feld

- **GIVEN** eine Anfrage `workspace.create` mit `name` und einem Feld `farbe`
- **WHEN** sie geparst wird
- **THEN** ist das Ergebnis `bad_request`, dessen Meldung `farbe` nennt

### Requirement: Teiländerungen der Phase 3

In `workspace.update`, `project.update`, `profile.update`, `session.update` und `settings.set` SHALL ein fehlendes Feld „unverändert“ bedeuten und `null` bei optionalen Feldern „entfernen“. `session.update { workspaceId: null }` macht die Session gruppenlos. Jede dieser Anfragen MUST mindestens ein Änderungsfeld tragen; `null` für ein Pflichtfeld MUST `bad_request` ergeben.

#### Scenario: Session gruppenlos machen

- **GIVEN** eine Anfrage `session.update { sessionId, workspaceId: null }`
- **WHEN** sie geparst wird
- **THEN** liefert der Parser `workspaceId: null`; `session.update { sessionId }` ohne Änderung ergibt `bad_request`

#### Scenario: Pflichtfeld auf null

- **GIVEN** eine Anfrage `workspace.update { workspaceId, name: null }` oder `settings.set { settings: { historyLimitBytes: null } }`
- **WHEN** sie geparst wird
- **THEN** ist das Ergebnis `bad_request`

### Requirement: Grenzen der Phase 3

Namen und Distributionen SHALL höchstens 128 Zeichen lang und nicht leer oder nur Leerzeichen sein, Pfade (auch `launch.cwd` eines Profils) höchstens 512 Zeichen ohne NUL. Listen SHALL höchstens 64 Workspaces mit je 16 Projekten und 64 Profile enthalten; als JSON ein Workspace samt Projekten höchstens 12 KiB, ein Profil höchstens 8 KiB. Die Grenzen MUST als Konstanten im Vertrag stehen; Parser MUST Werte darüber mit `bad_request` ablehnen.

#### Scenario: Name an der Grenze

- **GIVEN** eine Anfrage `workspace.create` mit einem Namen von 128 Zeichen
- **WHEN** sie geparst wird
- **THEN** ist sie gültig; mit 129 Zeichen oder dem Namen `"  "` ist das Ergebnis `bad_request`

#### Scenario: Zu großes Profil

- **GIVEN** eine Anfrage `profile.create`, deren `launch.env` das Profil über 8 KiB bringt
- **WHEN** sie geparst wird
- **THEN** ist das Ergebnis `bad_request`

#### Scenario: Volle Workspace-Liste

- **GIVEN** 64 Workspaces mit je 16 Projekten, deren Felder mit Zeichen gefüllt sind, die JSON auf 6 Bytes erweitert, jeder knapp unter 12 KiB
- **WHEN** sie als `workspace.changed` kodiert und geparst werden
- **THEN** bleibt der Header unter 1 MiB und das Event ist gültig; ein Workspace über 12 KiB ergibt `bad_request`

### Requirement: Backendwechsel eines Projekts

Setzt `project.update` das Backend auf `windows`, MUST die Anfrage `distro: null` tragen, sonst ist sie `bad_request`. Der Guard kennt die gespeicherte `distro` nicht; der Core löscht sie nicht stillschweigend.

#### Scenario: Wechsel auf Windows

- **GIVEN** eine Anfrage `project.update { projectId, backend: "windows" }`
- **WHEN** sie geparst wird
- **THEN** ist das Ergebnis `bad_request` mit `params.distro`; mit `distro: null` ist sie gültig

### Requirement: Einstellungen im Vertrag

`Settings` SHALL die festen Schlüssel `defaultDistro?`, `defaultShell?`, `defaultCwd?`, `historyLimitBytes`, `historyEnabledByDefault`, `confirmQuitWhileRunning` und `quitAction?` (`keepSessions` oder `stopSessions`) haben. Standard SHALL 10 MiB Verlauf, Verlauf an und Nachfrage beim Schließen an sein. `historyLimitBytes` MUST eine ganze Zahl von 64 KiB bis 1 GiB sein; unbekannte Schlüssel MUST `bad_request` ergeben.

#### Scenario: Teiländerung der Einstellungen

- **GIVEN** eine Anfrage `settings.set { settings: { historyLimitBytes: 65536, defaultDistro: null } }`
- **WHEN** sie geparst wird
- **THEN** ist sie gültig; mit `historyLimitBytes: 65535`, `1073741825` oder einem Schlüssel `farbe` ist das Ergebnis `bad_request`

### Requirement: Verlaufssuche im Vertrag

`history.search { query, sessionIds?, limit? }` SHALL `{ hits, truncated }` liefern. `query` MUST 1 bis 256 Zeichen haben, `sessionIds` 1 bis 256 IDs, `limit` eine ganze Zahl von 1 bis 200. Ein Treffer SHALL `sessionId`, `timestamp` (Millisekunden seit 1970), `line` (höchstens 512 Zeichen) und `offset` (Position in `line`, höchstens deren Länge) tragen; eine Antwort MUST höchstens 200 Treffer enthalten.

#### Scenario: Suche an den Grenzen

- **GIVEN** eine Anfrage `history.search` mit einem Suchtext von 256 Zeichen und `limit: 200`
- **WHEN** sie geparst wird
- **THEN** ist sie gültig; mit 257 Zeichen, leerem Suchtext, `limit: 0`, `limit: 201` oder `sessionIds: []` ist das Ergebnis `bad_request`

#### Scenario: Suchergebnis

- **GIVEN** eine Antwort auf `history.search` mit einem Treffer und `truncated: true`
- **WHEN** sie geparst wird
- **THEN** ist sie gültig; ohne `truncated`, mit negativem `offset` oder einem `offset` hinter dem Ende von `line` ist das Ergebnis `bad_request`

### Requirement: Prüfung zusammengeführter Objekte

Der Vertrag SHALL Prüffunktionen für fertige Workspaces, Projekte, Profile und Einstellungen bereitstellen, die dieselben Regeln wie die Parser anwenden. Weil Update-Anfragen nur Teiländerungen tragen, MUST der Core das zusammengeführte Objekt vor dem Speichern damit prüfen und sonst mit `bad_request` antworten, damit kein Client eine gespeicherte Liste ablehnt.

#### Scenario: Zusammengeführtes Projekt

- **GIVEN** ein Projekt mit Backend `windows` und eine Teiländerung, die nur `distro: "Ubuntu"` setzt
- **WHEN** das zusammengeführte Projekt geprüft wird
- **THEN** ist das Ergebnis `bad_request`, ebenso für ein Profil, das mit ID und Standardwerten über 8 KiB liegt

### Requirement: Anlegen aus Profil im Vertrag

`session.create` SHALL `launch` nur verlangen, wenn kein `profileId` gesetzt ist. Mit `profileId` und ohne `launch` MUST die Anfrage gültig sein; ohne beides MUST sie `bad_request` mit dem Feld `params.launch` ergeben.

#### Scenario: Anlegen aus Profil

- **GIVEN** eine Anfrage `session.create { name, profileId }` ohne `launch`
- **WHEN** sie geparst wird
- **THEN** ist sie gültig; `session.create { name }` ergibt `bad_request` mit `params.launch`
