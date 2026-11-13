# Proposal

## Why

Core und Desktop sind getrennte Prozesse (ADR 0001) und sprechen über eine lokale Named Pipe. Beide Seiten brauchen denselben, getesteten Vertrag (ADR 0002): Rahmung, Nachrichtenarten, Methoden, Fehlercodes und Handshake. Ohne ihn bauen Core-IPC-Server und Desktop-Client jeweils eigene, abweichende Parser.

## What Changes

- Frame-Codec in `packages/protocol`: `encodeFrame` und ein streaming-fähiger `FrameDecoder` (Längenpräfix, Header-JSON, Byte-Nutzdaten; Teilframes, mehrere Frames pro Chunk; Grenzen 1 MiB Header und 4 MiB Nutzdaten).
- Nachrichtentypen `request`, `response`, `event` und der `hello`-Handshake mit `PROTOCOL_VERSION`.
- Typen und handgeschriebene Laufzeit-Guards für alle Phase-1-Methoden und Events aus ADR 0002, inklusive der Festlegung, welche Nachricht Nutzdaten trägt.
- `model.ts` bleibt unverändert, nur der Export in `index.ts` wächst.

Phase: Phase 1 (Kapitel 12 des Konzepts, Core-Grundgerüst).

## Capabilities

### New Capabilities

- `ipc-protocol`: Frame-Format, Nachrichtenarten, Methoden mit Parametern, Ergebnissen und Nutzdaten, Events, Fehlercodes und Versions-Handshake der Core-IPC.

### Modified Capabilities

Keine.

## Impact

- Betroffenes Paket: nur `packages/protocol` (neue Dateien `frame.ts`, `messages.ts`, `guards.ts`, Export über `index.ts`).
- IPC-Methoden: `hello`, `session.create`, `session.list`, `session.attach`, `session.detach`, `session.input`, `session.resize`, `session.claimWriter`, `session.kill`, `core.shutdown`; Events `session.output`, `session.stateChanged`, `session.resized`, `view.writerChanged`.
- Datenmodelle: bestehende Typen aus `model.ts` werden wiederverwendet.
- Keine neuen Dependencies. Keine Node-spezifischen APIs (nur `Uint8Array`, `TextEncoder`, `TextDecoder`, `DataView`), damit das Paket auch im Electron-Preload und -Renderer läuft.

## Non-Goals

- Kein Pipe-Transport und kein IPC-Server (Core-Aufgabe), kein Client.
- Keine Workspace-, Profil- und Verlaufsmethoden (Phase 3).
- Keine Schema-Bibliothek.

## Security

- Der Decoder prüft Längenpräfixe, bevor er Speicher reserviert. Ein Peer kann so keine Allokation über 1 MiB (Header) oder 4 MiB (Nutzdaten) erzwingen.
- Eingehende Daten sind unvertraut: jeder Header wird vor der Nutzung durch Guards geprüft. Terminal-Bytes werden nie interpretiert.

## Breaking Changes

Keine. Bisher gibt es keinen IPC-Code.
