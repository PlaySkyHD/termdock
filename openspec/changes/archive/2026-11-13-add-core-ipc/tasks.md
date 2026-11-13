# Tasks

## 1. Protokoll-Korrektur

- [x] 1.1 `CoreShutdownParams { stopSessions? }` in `packages/protocol/src/messages.ts`, Guard in `guards.ts`; Test in `guards.test.ts`

## 2. Server

- [x] 2.1 Pipe-Name aus Benutzername bereinigen (`src/ipc/pipe-name.ts`); Test in `pipe-name.test.ts`
- [x] 2.2 Server mit Handshake, `session.create`/`session.list`, Fehlerabbildung; Integrationstest in `ipc.test.ts`
- [x] 2.3 Attach, Input, Resize, Schreibrecht (`not_writer`), Events an Views; Test in `ipc.test.ts`
- [x] 2.4 Client-Abbruch hängt Views ab; Backpressure trennt langsamen Client; Test in `ipc.test.ts`
- [x] 2.5 Einzelinstanz (`already_running`) über `runCore`; Test in `ipc.test.ts`
- [x] 2.6 `core.shutdown` mit und ohne `stopSessions`; Test in `ipc.test.ts`

## 3. Client und Einstieg

- [x] 3.1 Client-Bibliothek `connect`/`request`/`on`/`close` mit Timeout (`src/ipc/client.ts`); über die Integrationstests geprüft
- [x] 3.2 Einstieg `termdock-core` und `bin`-Eintrag; Rauchtest mit gebautem Paket (Start, zweite Instanz mit Exit-Code 10, Shutdown)
- [x] 3.3 Exporte unter `// ipc` in `src/index.ts`

## 4. Integration

- [x] 4.1 `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test -w packages/protocol` und `npm test -w packages/core` sind grün

## Workflow follow-up

- Change im selben Branch archivieren und `openspec validate --specs --strict` ausführen.
