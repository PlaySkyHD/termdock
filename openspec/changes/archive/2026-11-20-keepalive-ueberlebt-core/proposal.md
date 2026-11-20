# Proposal

## Why

Ein Update oder eine Deinstallation per NSIS beendet jeden Prozess unter `$INSTDIR`, auch den Core, ohne `core.shutdown` (ADR 0007). Der WSL-Keepalive `wsl.exe … sleep infinity` startet heute ohne `detached` und liegt damit im Job-Objekt, das libuv für die Kindprozesse des Core anlegt (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`). Er endet mit dem Core. Danach läuft kein `wsl.exe` mehr, WSL beendet die Distro samt tmux nach 8–20 s, und die Sessions des Nutzers sind weg (#140). Dasselbe gilt für jeden harten Abbruch des Core, etwa im Task-Manager, und für ein sauberes `core.shutdown` ohne `stopSessions`: Der Abbau beendet den Keepalive ausdrücklich.

## What Changes

- Der Keepalive startet `detached` (außerhalb des Job-Objekts) und überlebt so das Ende des Core.
- Der Keepalive ist kein `sleep infinity` mehr, sondern ein tmux-Client, der auf einen Kanal wartet, den niemand auslöst: `wsl.exe -d <distro> --cd ~ --exec tmux -L <socket> wait-for termdock-keepalive`. Er endet mit dem tmux-Server, ein verwaister Keepalive hält WSL also höchstens so lange wach, wie Sessions auf dem Socket leben.
- Übernahme: Bevor ein Backend den ersten Keepalive einer Distro startet, beendet es verbliebene Keepalives desselben Sockets (`pkill -x -f 'tmux -L <socket> wait-for termdock-keepalive'`, Argument-Array) und startet erst danach seinen eigenen. Nach beliebig vielen Core-Neustarts läuft je Distro und Socket genau einer.
- Abbau: `WslBackend.dispose()` lässt laufende Keepalives weiterlaufen und startet keine mehr. `core.shutdown { stopSessions: true }` beendet die Sessions; damit enden die Keepalives wie bisher mit der letzten Session (und spätestens mit dem tmux-Server).
- ADR 0003 (Keepalive, Grenze ohne Core), ADR 0001 (Abbau) und ADR 0007 (Update beendet den Core) anpassen.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `wsl-backend`: „Keepalive je Distro“ und „Keepalive-Neustart und Abbau“ (MODIFIED), neu „Übernahme verbliebener Keepalives“ (ADDED).
- `core-ipc`: „Abbau des Core“ (MODIFIED): Die Keepalives laufen nach dem Abbau weiter.

## Impact

- Pakete: nur `packages/core` (`backend/wsl/commands.ts`, `keepalive.ts`, `processes.ts`, `backend.ts`, Kommentar in `bin/run-core.ts`).
- IPC, Protokoll, Datenmodell und Desktop: unverändert. Kein neuer Prozess außer dem einmaligen `pkill`-Aufruf je Distro und Core-Start; keine neue Dependency (`pkill` gehört zu `procps`, in Ubuntu vorhanden; fehlt es, startet der Keepalive trotzdem).
- Security: Argument-Arrays wie bisher; der Socket-Name ist ein einfaches Wort (`[A-Za-z0-9_-]+`, bereits geprüft), enthält also keine Regex-Syntax für `pkill`. `pkill` trifft nur Prozesse des eigenen Linux-Benutzers mit genau dieser Befehlszeile.
- Non-Goals: Halte-Prozess im Installer (Variante B); Sessions über einen Windows-Neustart oder `wsl --shutdown` retten; Windows-Sessions (sie enden weiter mit dem Core, ADR 0001).
- Breaking Changes: keine nach außen. Ein Core der alten Version hinterlässt keinen Keepalive, den die neue übernehmen müsste.
