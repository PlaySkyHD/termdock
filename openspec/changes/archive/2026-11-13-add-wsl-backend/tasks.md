# Tasks

## 1. Grundlagen

- [x] 1.1 `node-pty` 1.1.0 exakt in `packages/core/package.json`, Lockfile aktualisiert
- [x] 1.2 Argumentbau und Parser (`commands.ts`) test-first: Start, Attach, Exists, Kill, Snapshot, Pane-Status, Keepalive, ID-, Socket- und Env-Prüfung, `env --` bei einem Befehlsargument, Distro-Liste; Test `commands.test.ts`
- [x] 1.3 `wslPath` (`paths.ts`); Test `paths.test.ts`

## 2. Bausteine

- [x] 2.1 `DistroKeepalive` mit injiziertem Spawner (Start bei erster, Ende bei letzter Session, Neustart nach unerwartetem Ende, `dispose`); Test `keepalive.test.ts`
- [x] 2.2 `WslPty` mit DA1-Antwort, Listener-Abbau bei `dispose`, Exit-Auflösung; Test `pty.test.ts` mit Fake-PTY
- [x] 2.3 Echte Prozesse (`processes.ts`): `execFile` mit `WSL_UTF8=1` und Timeout, Keepalive per `spawn`, node-pty mit `useConptyDll` (lazy geladen)

## 3. Backend

- [x] 3.1 `WslBackend` (`start`, `attach`, `exists`, `kill`, `snapshot`, `available`, `distros`, `dispose`) mit injiziertem Runner; Unit-Test `backend.test.ts`
- [x] 3.2 Integrationstests `backend.wsl.test.ts` hinter `TERMDOCK_WSL_TESTS=1`: `pwd`, Ein-/Ausgabe, Echo < 3 s nach Start und Attach, `stty size`, Detach/Exists/Attach/Snapshot, Client von außen getrennt, Kill, Exit-Code, Keepalive über 25 s
- [x] 3.3 Exporte in `packages/core/src/index.ts` unter `// wsl backend`

## 4. Integration

- [x] 4.1 `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test -w packages/core` und lokal `TERMDOCK_WSL_TESTS=1 npm test -w packages/core` grün

## Workflow follow-up

- Change im selben Branch archivieren und `openspec validate --specs --strict` ausführen.
