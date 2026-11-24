# Proposal

## Why

Beim Beenden vieler PTYs stürzt der Core gelegentlich mit 0xC0000005 ab (#160). Der Check `core shutdown` des Lasttests war unter Electron auf main in 2 von 3 Läufen rot. Ursache in node-pty 1.1.0 (`conpty.cc`): Der Exit-Thread jeder ConPTY entfernt ihren Eintrag ohne Sperre aus einer gemeinsamen Liste (`remove_pty_baton`). Enden mehrere Prozesse im selben Moment, laufen diese Threads gleichzeitig. Das Reproduktionsskript zeigt das ohne WSL: Auf main stürzten mit 20 PTYs 2 bis 4 von 24 Abbau-Läufen ab und 6 von 24 Läufen, in denen alle Programme gleichzeitig von selbst endeten (wie nach `kill-session`).

## What Changes

- Eine Warteschlange in `backend/wsl/processes.ts` schließt alle PTYs des Prozesses nacheinander. Jede PTY wird erst geschlossen, wenn der Prozess der vorigen geendet hat, höchstens nach 2 s. Danach beendet der Core den Prozess selbst und wartet noch höchstens 0,5 s. `kill()` reiht nur ein, `closed()` meldet das Ende.
- Auch der Abbau nach einem Absturz des Lesers (#153) nutzt diese Schlange.
- Beim Ende wartet der Core auf die Schlange, höchstens 15 s, parallel zur Übergabe der Keepalives.
- `core.shutdown { stopSessions }` schließt je Session zuerst die PTY und beendet die tmux-Session erst danach (`SessionRegistry.killAll`). Die tmux-Clients enden so nicht mehr alle im selben Moment. Die tmux-Sessions enden weiter gleichzeitig.
- Neues Skript `scripts/pty-shutdown-repro.mjs` (ohne WSL), dazu ein Test über den Pfad des Core mit `cmd.exe`, der auch auf `windows-latest` läuft.
- Der Lasttest zeigt die Dauer des Shutdowns.
- Nachtrag in ADR 0008.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `wsl-backend`: neu „PTYs enden nacheinander“ (ADDED).
- `core-ipc`: neu „PTYs vor den Sessions beim Shutdown mit Stop“ (ADDED).

## Impact

- Pakete: `packages/core` (`backend/wsl/close-queue.ts` neu, `backend/wsl/processes.ts`, `backend/wsl/pty.ts`, `backend/wsl/backend.ts`, `backend/types.ts` mit dem optionalen `PtyHandle.closed()`, `session/registry.ts`, `ipc/server.ts`); Skripte `scripts/pty-shutdown-repro.mjs`, `scripts/load-test.mjs`.
- IPC, Protokoll, Datenmodell und Desktop: unverändert.
- Abhängigkeiten: keine neue.
- Security: unverändert.
- Non-Goals: Handle-Leak beim natürlichen Ende (#177). Gleichzeitige Enden, die der Core nicht auslöst (z. B. Ende des tmux-Servers), bleiben ein Restrisiko.
- Breaking Changes: keine.
