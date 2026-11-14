# Tasks

## 1. Messung

- [x] 1.1 WSL-Integrationstest: drei Clients hängen bei laufender Ausgabe an, Snapshot plus Live-Ausgabe ergeben im Terminal-Emulator genau `capture-pane` (`e2e.wsl.test.ts`, `@xterm/headless` als devDependency); rot vor der Änderung

## 2. Protokoll

- [x] 2.1 Test: `outputSeq` im Attach-Ergebnis und `seq` in `session.output` optional, nicht negative ganze Zahlen; Version `1.1` (`guards.test.ts`)
- [x] 2.2 Felder, Guards und `PROTOCOL_VERSION` umgesetzt

## 3. Core

- [x] 3.1 Test: Nummern je Session, Marke beim Anhängen, Ausgabe während der Abfrage nicht angehängt und unter der Marke (`registry.test.ts`)
- [x] 3.2 Registry: Nummern statt `inFlight`
- [x] 3.3 Test: Neuzeichnen nach Backend-Snapshot, nicht beim Puffer, Fehler ignoriert (`registry.test.ts`)
- [x] 3.4 Backend-Schnittstelle `redraw?`, `FakeBackend`, Registry ruft es nach dem Registrieren auf
- [x] 3.5 Test: Server sendet `seq` und `outputSeq` (`ipc.test.ts`)
- [x] 3.6 Server umgesetzt
- [x] 3.7 Test: `listClientsArgs`, `refreshClientArgs`, `parseClientTtys` verwirft fremde Namen (`commands.test.ts`); `redraw` über den Runner (`backend.test.ts`) und gegen WSL (`backend.wsl.test.ts`)
- [x] 3.8 WSL-Backend `redraw` umgesetzt; Integrationstest aus 1.1 grün

## 4. Desktop

- [x] 4.1 Test: Main nimmt `seq` und `outputSeq` des Core, zählt ohne sie selbst (`bridge.test.ts`)
- [x] 4.2 `bridge.ts` umgesetzt

## 5. Dokumentation

- [x] 5.1 ADR 0003 (bekannte Grenze ersetzt), ADR 0006 (Marke vom Core), ADR 0002 (Version 1.1)
