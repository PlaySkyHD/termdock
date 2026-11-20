# Proposal

## Why

Mit 50 WSL-Sessions braucht der Core 588 MiB RSS unter Node und 386 MiB unter Electron (Lasttest aus #134), über dem Grenzwert von 300 MiB (#153). Ursache: node-pty 1.1.0 startet unter Windows je PTY einen eigenen Worker-Thread (`ConoutConnection`), also je Session eine eigene V8-Instanz mit 8 bis 12 MiB. Der Worker leitet nur die Ausgabe-Pipe der ConPTY an den Hauptthread weiter. Sein Start kostet zudem rund 55 ms je PTY, die den Abgleich beim Core-Start auf knapp 3 s treiben. Der Spike zu #153 hat die Varianten gemessen; entschieden ist ein gemeinsamer Worker für alle PTYs.

## What Changes

- Neues Modul `packages/core/src/backend/wsl/conout-reader.ts`: ein Worker-Thread je Core-Prozess (Quelltext inline, `eval`), der die Ausgabe-Pipes aller PTYs weiterleitet. Er ersetzt vor dem ersten `spawn` die interne Klasse `ConoutConnection` von node-pty, nur für die gepinnte Version 1.1.0.
- Andere node-pty-Version: eine Logzeile auf stderr, node-pty bleibt unverändert (ein Worker je PTY). Ein Test schlägt fehl, sobald die installierte Version nicht 1.1.0 ist.
- `spawnPty` startet eine PTY erst, wenn der Worker läuft (node-pty wartet sonst synchron in `ConnectNamedPipe`).
- Absturz des Workers: Der Core beendet alle PTYs, jede meldet ihr Ende genau einmal ohne Exit-Code, die Registry hängt die tmux-Sessions neu an wie nach einem verlorenen Client; der nächste Start einer PTY startet einen neuen Worker.
- Der Worker schließt die Pipe einer PTY auch dann, wenn sie ohne `kill` endet. node-pty 1.1.0 mit `useConptyDll` beendet seinen Worker in diesem Fall nie.
- ADR 0008 (neu) und ein Nachtrag in ADR 0003.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `wsl-backend`: neu „Gemeinsamer Leser für die ConPTY-Ausgabe“, „Leser nur für node-pty 1.1.0“ und „Absturz des Lesers“ (ADDED).

## Impact

- Pakete: `packages/core` (`backend/wsl/conout-reader.ts`, `backend/wsl/processes.ts`); Tests `backend/wsl/conout-reader.test.ts` (Windows, ohne WSL, läuft auch in der CI) und `conout-reader.wsl.test.ts` (WSL, eigener Socket).
- IPC, Protokoll, Datenmodell, Desktop und Paketierung: unverändert. Der Worker braucht keine eigene Datei im Paket.
- Abhängigkeiten: keine neue; `node_modules` bleibt unverändert (kein `patch-package`).
- Security: unverändert. Die Named Pipes legt wie bisher node-pty an; der Worker öffnet nur Pipes, die node-pty ihm nennt.
- Non-Goals: PTY nur bei angehängter View (Spike, ADR 0008 verworfen), Absturz beim Beenden vieler PTYs (#160).
- Breaking Changes: keine.
