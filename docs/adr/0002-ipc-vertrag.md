# ADR 0002: IPC-Vertrag zwischen Client und Core

Status: angenommen (13.11.2026)

## Kontext

Fenster und Core sind getrennte Prozesse (ADR 0001). Ausgabe kann sehr groß werden (Abnahme 11). Der Vertrag muss in `packages/protocol` liegen und von Core und Desktop gleich verwendet werden.

## Entscheidung

- **Transport:** Windows Named Pipe `\\.\pipe\termdock-core-<windows-benutzer>`, nur für den aktuellen Benutzer zugänglich. Kein TCP. In Tests ein eindeutiger Pipe-Name je Test.
- **Rahmung:** Längenpräfix. Jeder Frame ist `uint32 BE Länge des Headers | Header (UTF-8-JSON) | uint32 BE Länge der Nutzdaten | Nutzdaten (Bytes)`. Terminal-Ein- und -Ausgabe stehen als rohe Bytes in den Nutzdaten, nicht als Base64 im JSON. Maximale Headergröße 1 MiB, maximale Nutzdaten 4 MiB; größere Frames sind ein Protokollfehler.
- **Nachrichtenarten im Header** (`kind`):
  - `request` mit `id`, `method`, `params`; Antwort `response` mit gleicher `id` und `result` oder `error { code, message }`.
  - `event` ohne `id` vom Core an Clients (z. B. `session.output`, `session.stateChanged`, `view.writerChanged`).
- **Versionierung:** Erste Nachricht jedes Clients ist `hello { protocolVersion, clientId, clientKind }`. Der Core antwortet mit seiner `protocolVersion`; bei Unterschied in der Hauptversion `error { code: "protocol_mismatch" }` und Verbindungsabbau.
- **Methoden in V1 (Phase 1):** `session.create`, `session.list`, `session.attach` (legt eine View an, liefert Snapshot), `session.detach`, `session.input` (nur von der schreibenden View), `session.resize` (nur von der schreibenden View), `session.claimWriter`, `session.kill`, `core.shutdown`. Workspaces, Profile und Verlauf folgen in Phase 3.
- **Fehlercodes** sind stabile Strings: `protocol_mismatch`, `bad_request`, `not_found`, `not_writer`, `invalid_state`, `backend_unavailable`, `internal`.
- Schemas als TypeScript-Typen mit Laufzeitprüfung an der Pipe-Grenze (handgeschriebene Guards, keine Schema-Bibliothek, bis ein OpenSpec-Design etwas anderes begründet).

## Folgen

- Die Desktop-App leitet Renderer-Nachrichten über Preload und Main an die Pipe weiter. Der Renderer hat keinen direkten Pipe-Zugriff.
- Der Codec ist reine Logik und wird ohne Pipe getestet (Teilframes, mehrere Frames pro Chunk, Übergröße).
