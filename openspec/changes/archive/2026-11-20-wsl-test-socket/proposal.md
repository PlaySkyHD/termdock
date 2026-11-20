# Proposal

## Why

Die WSL-Integrationstests (`TERMDOCK_WSL_TESTS=1`) teilten sich den tmux-Socket `termdock-test` und räumten am Testende alle `td-*`-Sessions darauf ab. Zwei Worktrees, die zugleich testeten, beendeten sich gegenseitig die Sessions: ein Agent musste warten, und fremde Tests scheiterten zufällig (`e2e … issue #88`, `history-search … deleted during the search`). Nur `autostart.wsl.test.ts` hatte schon einen eigenen Socket (#147).

## What Changes

- Neuer Test-Helfer `packages/core/src/test/wsl-socket.ts`: `wslTestSocket()` liefert je Testdatei einen Socket `termdock-test-<pid>-<nonce>` (die Form der Screenshot-Läufe), `killWslTestServer` beendet nur den Server eines solchen Sockets, `cleanStaleWslTestServers` beendet Server von Sockets beendeter Prozesse.
- `backend.wsl.test.ts`, `e2e.wsl.test.ts`, `session-management.wsl.test.ts` und `autostart.wsl.test.ts` nutzen den Helfer und beenden am Ende ihren eigenen Server.
- Ein Unit-Test in der CI prüft, dass keine `*.wsl.test.ts` den festen Namen `"termdock-test"` mehr enthält.
- `docs/agent-lessons-learned.md`, Abschnitt WSL, und die Test-Regel in `typescript.instructions.md` nennen den Socket je Lauf.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `wsl-backend`: WSL-Integrationstests nutzen einen eigenen tmux-Socket je Testdatei.

## Impact

`packages/core` (neu: `src/test/wsl-socket.ts` und Test; geändert: vier `*.wsl.test.ts`, `vitest.config.ts`), Docs. Kein Produktivcode, Protokoll und IPC bleiben unverändert. Die Anforderung „Screenshot-Modus gegen isolierten Core“ (`desktop-shell`) nennt im Szenario „Parallele Läufe“ noch `termdock-test` für WSL-Tests; das Szenario bleibt richtig, weil Screenshot-Läufe nie den festen Socket benutzen.
