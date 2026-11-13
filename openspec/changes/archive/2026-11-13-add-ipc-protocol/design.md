# Design

## Context

ADR 0002 legt Rahmung, Grenzen, Nachrichtenarten, Methoden, Fehlercodes und `hello` fest. `packages/protocol` enthält bisher nur `model.ts` (Domänentypen, `ERROR_CODES`, `PROTOCOL_VERSION = "1.0"`). `packages/core` nutzt diese Typen und darf nicht brechen.

## Goals / Non-Goals

**Goals:**

- Ein reiner Logik-Baustein ohne Pipe, ohne Node-APIs, vollständig über öffentliche Funktionen testbar.
- Fehler an der Grenze mit stabilem Code und verständlicher Meldung.

**Non-Goals:**

- Transport, Verbindungszustand (z. B. "hello zuerst"), Zuordnung von Antworten zu Anfragen. Das gehört in Core-IPC-Server und Client.

## Decisions

- **Dateien:** `frame.ts` (Codec), `messages.ts` (Typen und Methodentabellen), `guards.ts` (Parser). `index.ts` exportiert alle.
- **Frame:** `encodeFrame(header, payload?)` liefert ein `Uint8Array`. `FrameDecoder.push(chunk)` liefert die fertig gewordenen `Frame { header: unknown, payload: Uint8Array }`. Der Decoder hält je Abschnitt (Headerlänge, Header, Nutzdatenlänge, Nutzdaten) einen Puffer genau der benötigten Größe und füllt ihn; das ist linear auch bei byteweiser Zufuhr. Die Längenprüfung erfolgt sofort nach dem Lesen des Präfixes, vor der Allokation.
- **Fehlerverhalten:** `ProtocolError` (mit `code: ErrorCode`) bei Übergröße, kaputtem UTF-8/JSON oder einem Header, der kein JSON-Objekt ist. Nach einem Fehler ist der Decoder verbraucht und wirft bei jedem weiteren `push` denselben Fehler; die Verbindung ist abzubauen (ADR 0002: Protokollfehler). Fehlercode ist `bad_request`. Frames, die im selben Chunk vor dem Fehler vollständig waren, werden von diesem `push` noch geliefert; der Fehler wird erst beim nächsten `push` geworfen. So gilt "je Chunk alle vollständigen Frames in Reihenfolge" auch bei kaputten Nachfolgern.
- **`hello` als Request:** `hello` ist eine Request-Methode (`id`, `method: "hello"`, `params { protocolVersion, clientId, clientKind }`), die Antwort trägt `result { protocolVersion }`. So braucht es keine vierte Nachrichtenart. `negotiateHello(params)` vergleicht die Hauptversion (Teil vor dem ersten Punkt) mit `PROTOCOL_VERSION` und liefert bei Unterschied `protocol_mismatch`. Dass `hello` die erste Nachricht sein muss und die Verbindung danach abgebaut wird, setzt der Core-IPC-Server durch. `clientKind` ist ein nicht leerer String (höchstens 64 Zeichen), weil ADR 0002 keine feste Menge nennt.
- **Parser-Schnittstelle:** `parseRequest(frame)`, `parseResponse(frame, method)`, `parseEvent(frame)` liefern `{ ok: true, value }` oder `{ ok: false, id?, error: { code, message } }`. Kein Werfen im Normalfall; bei einer kaputten Anfrage liefert der Parser die `id` (falls lesbar) mit, damit der Server mit `bad_request` antworten kann. Unbekannte Methoden sind `bad_request`.
- **Nutzdaten je Nachricht** (Tabellen `REQUEST_PAYLOAD`, `RESPONSE_PAYLOAD`, `EVENT_PAYLOAD`):
  - `session.input` (Request): Nutzdaten erforderlich und nicht leer (Eingabe-Bytes).
  - `session.attach` (Response): Nutzdaten erforderlich, dürfen leer sein (Snapshot-Bytes); Result: `viewId`, `size`, optional `writerViewId`.
  - `session.output` (Event): Nutzdaten erforderlich und nicht leer.
  - Alle anderen Nachrichten: Nutzdaten müssen leer sein.
  - `session.attach` bekommt als Params `sessionId` und optional `size`; `session.input` und `session.resize` adressieren die View (`viewId`), weil nur die schreibende View senden darf; `session.claimWriter` und `session.detach` ebenfalls `viewId`.
- **Fehlerantwort:** `error { code, message }`; `code` muss in `ERROR_CODES` stehen, `message` ist ein String.
- **Eingabehärtung:** Ids (`id`, `clientId`, `sessionId`, `viewId`, `workspaceId`, `profileId`, `writerViewId`) sind höchstens 128 Zeichen lang. Fremde Werte in Fehlermeldungen (Methode, Event, Version, Env-Namen) werden auf 64 Zeichen gekürzt. Versionen haben das Format `<Zahl>.<Zahl>` ohne führende Nullen. `distro` ist nur bei Backend `wsl`, `shell` nur bei Backend `windows` erlaubt.
- **Terminalgröße:** ganze Zahlen von 1 bis 10000 für `cols` und `rows`.
- **Keine Node-APIs und keine neuen Dependencies:** `Uint8Array`, `TextEncoder`/`TextDecoder` (fatal, damit kaputtes UTF-8 auffällt), `DataView`.

## Risks / Trade-offs

- Ein Fehler in einem Chunk wird um einen `push` verzögert gemeldet, wenn davor schon Frames fertig waren; Aufrufer müssen die Verbindung beim geworfenen Fehler abbauen.
- Die Methodentabellen sind handgepflegt; ein vergessener Eintrag fällt durch Typprüfung (`Record<Method, ...>`) und Tests auf.
- `clientKind` bleibt offen; ein späteres Einschränken wäre eine Vertragsänderung innerhalb der Nebenversion.
