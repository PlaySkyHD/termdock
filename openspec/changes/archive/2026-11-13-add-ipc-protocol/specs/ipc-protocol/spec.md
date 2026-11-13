## ADDED Requirements

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

Der Vertrag SHALL die Methoden `hello`, `session.create`, `session.list`, `session.attach`, `session.detach`, `session.input`, `session.resize`, `session.claimWriter`, `session.kill` und `core.shutdown` mit typisierten Parametern und Ergebnissen definieren; Parser SHALL Anfragen und Antworten gegen diese Typen prüfen.

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

### Requirement: Events

Der Core SHALL Clients über die Events `session.output` (Bytes in den Nutzdaten), `session.stateChanged`, `session.resized` und `view.writerChanged` informieren; Parser SHALL ihre Payloads prüfen.

#### Scenario: Ausgabe-Event

- **GIVEN** ein `event` `session.output` mit `sessionId` und Nutzdaten
- **WHEN** es geparst wird
- **THEN** liefert der Parser Session und Bytes; ohne Nutzdaten ist das Ergebnis `bad_request`

#### Scenario: Schreiberwechsel ohne Schreiber

- **GIVEN** ein `event` `view.writerChanged` ohne `writerViewId`
- **WHEN** es geparst wird
- **THEN** ist das gültig und bedeutet: aktuell schreibt keine View

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
