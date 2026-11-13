# Proposal

## Why

Der Core braucht eine zentrale Session-Verwaltung, bevor IPC, Storage und das WSL-Backend darauf aufbauen können (Phase 1 – Kernsystem, Kapitel 12). Ohne festen Zustandsautomaten und Eingabe-Lock würden Mehrfenster-Betrieb (Abnahme 5) und das Erkennen verlorener Prozesse (Abnahme 9) in jedem Client neu und uneinheitlich gelöst.

## What Changes

- Neuer Zustandsautomat für Sessions mit genau den Übergängen aus ADR 0005; jeder andere Übergang wird mit dem Fehlercode `invalid_state` abgelehnt.
- Neue Session Registry im Core: stabile Session-IDs (UUID), Anlegen und Starten über die Backend-Schnittstelle, Views anhängen und trennen (`Running` ↔ `Detached`), PTY-Ende als `Exited` (mit Exit-Code) oder `Interrupted` (unerwartet), Beenden, Neustart derselben Session-ID und Archivieren.
- Eingabe-Lock: höchstens eine schreibende View pro Session, atomare Übernahme des Schreibrechts, Eingabe und Resize nur durch den Schreiber (`not_writer`).
- Verteilung der PTY-Ausgabe an alle Views über typisierte Listener sowie Listener für Zustand, Schreiberwechsel und maßgebliche Größe.
- Rohdaten-Puffer von 256 KiB je Session als Snapshot-Fallback für Backends ohne eigenen Bildschirminhalt (ADR 0003).
- `FakeBackend` als Test-Backend, exportiert für andere Pakete.
- Keine Breaking Changes: Das Paket `@termdock/core` exportiert bisher nur die Backend-Typen.

## Capabilities

### New Capabilities

- `session-lifecycle`: Zustände und Übergänge einer Session, Views und Eingabe-Lock, Ausgabeverteilung und Snapshot-Fallback im Core.

### Modified Capabilities

(keine)

## Impact

- Paket `packages/core`: neue Module `src/session/` (Zustandsautomat, Registry, Fehlerklasse, Ausgabepuffer) und `src/backend/fake.ts`; Exporte in `src/index.ts`.
- `packages/protocol` und `packages/core/src/backend/types.ts` bleiben unverändert; genutzt werden `SessionInfo`, `SessionState`, `ErrorCode`, `LaunchSpec`, `TerminalSize` und die `Backend`-Schnittstelle.
- IPC-Methoden: keine neuen. Die Registry ist die Grundlage für `session.create`, `session.attach`, `session.input`, `session.resize`, `session.claimWriter`, `session.kill`, `session.restart`, `session.archive` und die Events `session.output`, `session.resized`, `view.writerChanged`, die der IPC-Server später anbindet.
- Datenmodell: keine Änderung. Die Registry hält `SessionInfo` im Speicher; Persistenz folgt mit dem Storage-Issue.
- Dependencies: keine neuen (UUID über `crypto.randomUUID` aus Node).
- Non-Goals: kein IPC-Server, kein Storage, kein Verlauf/History-Ringpuffer, kein WSL- oder Windows-Backend, kein Reconcile beim Core-Start, kein Autostart.
- Security: Terminal-Ausgabe wird nur gepuffert und weitergereicht, nie interpretiert. Der Puffer liegt nur im Speicher und ist auf 256 KiB je Session begrenzt; es werden keine Daten auf die Platte geschrieben.
