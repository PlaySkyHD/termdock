# Tasks

## 1. Helfer für den Socket je Testdatei

- [x] 1.1 `wslTestSocket`, `socketRunPid`, `staleWslTestSockets`, `killWslTestServer`, `cleanStaleWslTestServers` (`packages/core/src/test/wsl-socket.ts`; Test `test/wsl-socket.test.ts`: Namensform, eindeutig je Aufruf, fremde Namen erkannt, nur Sockets beendeter Prozesse veraltet, `termdock` und `termdock-test` werden nicht beendet)

## 2. WSL-Tests nutzen den Helfer

- [x] 2.1 `backend`, `e2e`, `session-management` und `autostart` nehmen `wslTestSocket()` und beenden am Ende ihren Server (Lauf `TERMDOCK_WSL_TESTS=1 npm test -w packages/core`, zwei Läufe gleichzeitig ohne Störung)
- [x] 2.2 Test: keine `*.wsl.test.ts` in `packages/` und `apps/` enthält den festen Namen `"termdock-test"` (`test/wsl-socket.test.ts`)

## 3. Doku

- [x] 3.1 `docs/agent-lessons-learned.md` (Abschnitt WSL, Tests) und `typescript.instructions.md` nennen den Socket je Lauf (geprüft durch den Test aus 2.2 für den Code, Doku per Review)
