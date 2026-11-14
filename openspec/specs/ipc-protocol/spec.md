# ipc-protocol Specification

## Purpose
Legt den IPC-Vertrag zwischen Core und Clients fest (ADR 0002): Frame-Format mit Größengrenzen, streaming-fähige Dekodierung, Nachrichtenarten, Phase-1-Methoden und Events mit Nutzdatenregeln, Fehlercodes und Versions-Handshake. Der Vertrag ist reine Logik ohne Transport und ohne Node-spezifische APIs.

## Requirements

### Requirement: Frame-Format

Jede IPC-Nachricht SHALL als Frame übertragen werden: `uint32 BE Länge des Headers | Header (UTF-8-JSON-Objekt) | uint32 BE Länge der Nutzdaten | Nutzdaten (Bytes)`. Terminal-Ein- und -Ausgabe SHALL als rohe Bytes in den Nutzdaten stehen, nicht im JSON.

#### Scenario: Roundtrip

- **GIVEN** ein Header-Objekt und Nutzdaten mit beliebigen Bytes (auch 0x00 und 0xFF)
- **WHEN** der Frame kodiert und wieder dekodiert wird
- **THEN** sind Header und Nutzdaten byteweise gleich

#### Scenario: Frame ohne Nutzdaten

- **GIVEN** ein Header ohne Nutzdaten
- **WHEN** der Frame kodiert wird
- **THEN** ist die Nutzdatenlänge 0 und das Dekodieren liefert leere Nutzdaten

### Requirement: Streaming-Decoder

Der Decoder SHALL Frames aus beliebig zerteilten Byteströmen zusammensetzen und je Eingabe-Chunk alle inzwischen vollständigen Frames in Reihenfolge liefern.

#### Scenario: Frame über mehrere Chunks

- **GIVEN** ein kodierter Frame
- **WHEN** er in zwei oder mehr Chunks an den Decoder gegeben wird, auch Byte für Byte
- **THEN** liefert der Decoder den Frame genau einmal, sobald das letzte Byte eingetroffen ist, und vorher nichts

#### Scenario: Mehrere Frames in einem Chunk

- **GIVEN** mehrere aneinandergehängte Frames in einem Chunk
- **WHEN** der Chunk an den Decoder gegeben wird
- **THEN** liefert der Decoder alle Frames in der gesendeten Reihenfolge

### Requirement: Größengrenzen

Der Header SHALL höchstens 1 MiB (1048576 Bytes) und die Nutzdaten höchstens 4 MiB (4194304 Bytes) groß sein. Größere Frames SHALL ein Protokollfehler mit Code `bad_request` sein. Der Decoder SHALL die Grenze am Längenpräfix prüfen, bevor er die Daten puffert. Der Encoder SHALL Übergröße ebenfalls ablehnen.

#### Scenario: Header zu groß

- **GIVEN** ein Längenpräfix für den Header von mehr als 1 MiB
- **WHEN** der Decoder es liest
- **THEN** wirft er einen Protokollfehler, ohne den Header abzuwarten

#### Scenario: Nutzdaten zu groß

- **GIVEN** ein Längenpräfix für die Nutzdaten von mehr als 4 MiB
- **WHEN** der Decoder es liest
- **THEN** wirft er einen Protokollfehler

#### Scenario: Genau an der Grenze

- **GIVEN** Nutzdaten von genau 4 MiB
- **WHEN** der Frame kodiert und dekodiert wird
- **THEN** ist das erlaubt

### Requirement: Fehler bei kaputtem Header

Ein Header, der kein gültiges UTF-8-JSON-Objekt ist, SHALL einen Protokollfehler auslösen. Nach einem Protokollfehler SHALL der Decoder unbrauchbar bleiben und jede weitere Eingabe mit einem Fehler ablehnen. Frames, die im selben Chunk vor dem fehlerhaften vollständig waren, SHALL der Decoder noch liefern; der Fehler SHALL beim nächsten `push` geworfen werden.

#### Scenario: Gültiger Frame vor kaputtem Frame im selben Chunk

- **GIVEN** ein Chunk mit zwei gültigen Frames, gefolgt von einem Frame mit kaputtem JSON
- **WHEN** der Decoder den Chunk verarbeitet
- **THEN** liefert er die zwei gültigen Frames und wirft den Protokollfehler erst beim nächsten `push`

#### Scenario: Kaputtes JSON

- **GIVEN** ein Frame, dessen Header `{kaputt` ist
- **WHEN** der Decoder ihn verarbeitet
- **THEN** wirft er einen Protokollfehler mit Code `bad_request`

#### Scenario: Header ist kein Objekt

- **GIVEN** ein Frame, dessen Header gültiges JSON, aber ein Array oder eine Zahl ist
- **WHEN** der Decoder ihn verarbeitet
- **THEN** wirft er einen Protokollfehler

### Requirement: Nachrichtenarten

Der Header SHALL ein Feld `kind` mit einem der Werte `request`, `response` oder `event` tragen. Ein `request` SHALL `id`, `method` und `params` tragen. Eine `response` SHALL dieselbe `id` und entweder `result` oder `error { code, message }` tragen. Ein `event` SHALL keine `id` tragen. `code` SHALL einer der stabilen Fehlercodes `protocol_mismatch`, `bad_request`, `not_found`, `not_writer`, `invalid_state`, `backend_unavailable`, `internal` sein.

#### Scenario: Gültige Anfrage

- **GIVEN** ein Frame mit `kind: "request"`, `id`, bekannter `method` und gültigen `params`
- **WHEN** er geparst wird
- **THEN** liefert der Parser die typisierte Anfrage samt Nutzdaten

#### Scenario: Unbekannte Methode

- **GIVEN** ein `request` mit `method: "session.fliegen"`
- **WHEN** er geparst wird
- **THEN** ist das Ergebnis ein Fehler `bad_request`, dessen Meldung die Methode nennt, und die lesbare `id` wird mitgeliefert

#### Scenario: Pflichtfeld fehlt

- **GIVEN** ein `request` `session.resize` ohne `size`
- **WHEN** er geparst wird
- **THEN** ist das Ergebnis ein Fehler `bad_request`, dessen Meldung das fehlende Feld benennt

#### Scenario: Unbekannter Fehlercode in Antwort

- **GIVEN** eine `response` mit `error.code: "kaputt"`
- **WHEN** sie geparst wird
- **THEN** ist das Ergebnis ein Fehler `bad_request`

### Requirement: Methoden der Phase 1

Der Vertrag SHALL die Methoden `hello`, `session.create`, `session.list`, `session.attach`, `session.detach`, `session.input`, `session.resize`, `session.claimWriter`, `session.kill`, `core.status`, `core.shutdown`, `layout.get` und `layout.save` mit typisierten Parametern und Ergebnissen definieren; Parser SHALL Anfragen und Antworten gegen diese Typen prüfen. `core.shutdown` SHALL den optionalen booleschen Parameter `stopSessions` tragen.

#### Scenario: session.attach liefert Snapshot

- **GIVEN** eine Antwort auf `session.attach`
- **WHEN** sie geparst wird
- **THEN** enthält sie `viewId`, `size`, optional `writerViewId` im Ergebnis und den Snapshot als Nutzdaten (leer erlaubt)

#### Scenario: session.input trägt Bytes

- **GIVEN** eine Anfrage `session.input` mit `viewId` und nicht leeren Nutzdaten
- **WHEN** sie geparst wird
- **THEN** liefert der Parser die Bytes unverändert; ohne Nutzdaten ist das Ergebnis `bad_request`

#### Scenario: Nutzdaten bei Methode ohne Nutzdaten

- **GIVEN** eine Anfrage `session.kill` mit nicht leeren Nutzdaten
- **WHEN** sie geparst wird
- **THEN** ist das Ergebnis `bad_request`

#### Scenario: core.shutdown mit stopSessions

- **GIVEN** eine Anfrage `core.shutdown` mit `stopSessions: true`
- **WHEN** sie geparst wird
- **THEN** liefert der Parser den Wert; ein nicht boolescher Wert ergibt `bad_request`, und `{}` bleibt gültig

#### Scenario: layout.save mit baseRevision

- **GIVEN** eine Anfrage `layout.save` mit gültigem `layout` und `baseRevision: 2`
- **WHEN** sie geparst wird
- **THEN** liefert der Parser beide Werte; ein ungültiges Layout oder ein negatives oder nicht ganzzahliges `baseRevision` ergibt `bad_request`

#### Scenario: layout.get ohne Layout

- **GIVEN** eine Antwort auf `layout.get` mit `revision: 0` und ohne `layout`
- **WHEN** sie geparst wird
- **THEN** ist sie gültig; ohne `revision` ergibt sie `bad_request`

### Requirement: Status-Abfrage

`core.status` SHALL ohne Parameter auskommen und im Ergebnis `backendUnavailable` als Liste von Backend-Arten (`wsl`, `windows`) liefern. Parser MUST ein fehlendes Feld, einen Nicht-Array-Wert und unbekannte Backend-Arten mit `bad_request` ablehnen.

#### Scenario: core.status

- **GIVEN** eine Antwort auf `core.status`
- **WHEN** sie mit `backendUnavailable: ["wsl"]` oder `[]` geparst wird
- **THEN** ist sie gültig; ein fehlendes Feld oder ein unbekannter Wert wie `"mac"` ergibt `bad_request`

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

### Requirement: Versions-Handshake

Die erste Nachricht jedes Clients SHALL die Anfrage `hello { protocolVersion, clientId, clientKind }` sein; der Core SHALL mit seiner `protocolVersion` antworten. Unterscheidet sich die Hauptversion, SHALL der Core mit dem Fehler `protocol_mismatch` antworten und die Verbindung abbauen. Der Protokoll-Baustein SHALL die Versionsprüfung bereitstellen; die Durchsetzung der Reihenfolge und den Verbindungsabbau übernimmt der IPC-Server.

#### Scenario: Gleiche Hauptversion

- **GIVEN** ein `hello` mit Version `1.7`, während der Core `1.0` spricht
- **WHEN** die Version ausgehandelt wird
- **THEN** ist das Ergebnis erfolgreich und enthält die Core-Version

#### Scenario: Falsche Hauptversion

- **GIVEN** ein `hello` mit Version `2.0`
- **WHEN** die Version ausgehandelt wird
- **THEN** ist das Ergebnis ein Fehler `protocol_mismatch`

#### Scenario: Ungültiges Versionsformat

- **GIVEN** ein `hello` mit `protocolVersion: "abc"` oder mit führenden Nullen wie `"01.0"`
- **WHEN** es geparst wird
- **THEN** ist das Ergebnis ein Fehler `bad_request`

### Requirement: Eingabehärtung

Ids (`id`, `clientId`, `sessionId`, `viewId`, `workspaceId`, `profileId`, `writerViewId`) SHALL höchstens 128 Zeichen lang sein. Fremde Werte in Fehlermeldungen SHALL auf 64 Zeichen gekürzt werden. In `LaunchSpec` SHALL `distro` nur bei Backend `wsl` und `shell` nur bei Backend `windows` erlaubt sein.

#### Scenario: Zu lange Id

- **GIVEN** eine Anfrage mit einer `sessionId` von 129 Zeichen
- **WHEN** sie geparst wird
- **THEN** ist das Ergebnis ein Fehler `bad_request`

#### Scenario: Lange Methode in Fehlermeldung

- **GIVEN** eine Anfrage mit einem Methodennamen von 10000 Zeichen
- **WHEN** sie geparst wird
- **THEN** ist die Fehlermeldung kürzer als 200 Zeichen

#### Scenario: Backend-fremdes Startfeld

- **GIVEN** ein `session.create` mit Backend `windows` und `distro`, oder Backend `wsl` und `shell`
- **WHEN** es geparst wird
- **THEN** ist das Ergebnis ein Fehler `bad_request`, der das Feld benennt

### Requirement: Keine Node-spezifischen APIs

Das Protokollpaket SHALL ohne Node-spezifische APIs auskommen (kein `Buffer`, kein `node:`-Import), damit es im Electron-Preload und -Renderer läuft. Nutzdaten SHALL als `Uint8Array` übergeben werden.

#### Scenario: Nutzdaten als Uint8Array

- **GIVEN** ein dekodierter Frame
- **WHEN** seine Nutzdaten abgefragt werden
- **THEN** sind sie ein `Uint8Array` und kein `Buffer`-abhängiger Typ

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
