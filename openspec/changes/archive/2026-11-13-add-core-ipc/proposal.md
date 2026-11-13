# Proposal

## Why

Registry und IPC-Vertrag liegen vor, aber noch nichts verbindet sie: Es gibt keinen Prozess, den Fenster erreichen können (ADR 0001), und keinen Transport für den Vertrag (ADR 0002). Ohne Core-Server mit Einzelinstanz und Client-Bibliothek kann die Desktop-App (Phase 1, Kapitel 12) weder Sessions anlegen noch sich mit mehreren Fenstern dieselbe Session teilen (Abnahme 5, 14).

## What Changes

- Neuer Named-Pipe-Server im Core auf `\\.\pipe\termdock-core-<benutzer>` (Pfad als Option): Frame-Rahmung und Guards aus `packages/protocol`, `hello`-Handshake als erste Nachricht, Dispatch der Phase-1-Methoden auf die `SessionRegistry`, Fehlerabbildung `CoreError.code` → `error.code`.
- Views gehören zur Verbindung: `session.attach` legt eine View für den Client an; trennt sich der Client, werden seine Views abgehängt, Sessions laufen weiter, der Schreiber verliert das Recht.
- Events (`session.output`, `session.resized`, `view.writerChanged`) gehen nur an Clients mit einer View der Session; `session.stateChanged` zusätzlich an Clients, die `session.list` genutzt haben.
- Backpressure: Pufferobergrenze je Client; wer nicht abliest, wird getrennt.
- Einzelinstanz: Belegen der Pipe scheitert mit `EADDRINUSE`, der zweite Core beendet sich mit dem Fehlercode `already_running` (Exit-Code 10, Meldung auf stderr).
- `core.shutdown { stopSessions }`: mit `true` werden alle laufenden Sessions beendet, dann der Server geschlossen; mit `false` nur der Server.
- Client-Bibliothek `connect`/`request`/`on`/`close` mit Timeout und automatischem `hello`.
- Einstieg `termdock-core` (`bin`-Eintrag in `packages/core/package.json`).
- **Vertragskorrektur** in `packages/protocol`: `core.shutdown` bekommt den optionalen Parameter `stopSessions` (ADR 0001 verlangt ihn, die Typen kannten ihn nicht).

## Capabilities

### New Capabilities

- `core-ipc`: Named-Pipe-Server, Handshake, Dispatch, Event-Verteilung, Verbindungs-Lebenszyklus, Einzelinstanz, Shutdown und Client-Bibliothek.

### Modified Capabilities

- `ipc-protocol`: `core.shutdown` trägt den optionalen Parameter `stopSessions`.

## Impact

- Paket `packages/core`: neue Module `src/ipc/` (Pipe-Name, Server, Client) und `src/bin/` (Einstieg); `bin`-Eintrag in `package.json`; Exporte unter `// ipc` in `src/index.ts`.
- Paket `packages/protocol`: `CoreShutdownParams` und Guard für `stopSessions`; abwärtskompatibel (Feld optional, `{}` bleibt gültig).
- `registry.ts` und `src/storage/` bleiben unberührt (parallele Arbeit); genutzt wird nur die öffentliche Registry-API.
- Dependencies: keine neuen (`node:net`, `node:os`, `node:crypto`).
- Non-Goals: keine Daemonisierung (kommt mit Desktop), kein Autostart, keine echten Backends im Einstieg, kein Reconnect in der Client-Bibliothek, keine Storage-Anbindung.
- Security: nur lokale Named Pipe, kein TCP. Eingehende Header werden durch die Guards geprüft; Fehlerantworten enthalten nie Stacktraces.
