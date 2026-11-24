# Proposal

## Why

Endet eine PTY von selbst (`cmd /c echo x`, Ende eines tmux-Clients), bleiben im Core 3 Kernel-Handles zurück, bei 20 PTYs also 60 (#177). Nach `kill` sind es 0. In einem lange laufenden Core wächst die Zahl mit jedem Ende eines tmux-Clients und jedem erneuten Anhängen. Die Ursache liegt in node-pty 1.1.0 mit `useConptyDll`: Nach dem natürlichen Ende schließt es weder die Eingabe-Pipe (`_inSocket`) noch das HPCON. Beides tut es nur in seinem eigenen `kill`.

## What Changes

- `spawnConpty` (`backend/wsl/processes.ts`) schließt die Eingabe-Pipe, sobald es das Ende einer PTY meldet, nicht mehr nur nach einem Verlust. Gemessen bleiben bei 20 PTYs 40 statt 60 Handles.
- Beim Schließen nach einem Verlust oder einer gescheiterten Weiterleitung schließt der Core die Verbindung des Lesers ausdrücklich (`ConoutConnection.close`). Er wartet nicht mehr darauf, dass der Client von `<pipe>-worker` geht.
- Das HPCON lässt sich aus JavaScript nicht sicher freigeben. ADR 0008 nennt das als Grenze, mit Begründung aus `conpty.cc`.
- Ein Test misst den Zuwachs an Handles nach 20 natürlich endenden PTYs.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `wsl-backend`: neu „Handles nach dem Ende einer PTY“ (ADDED).

## Impact

- Pakete: `packages/core` (`backend/wsl/processes.ts`); Tests `backend/wsl/conpty-handles.test.ts` (neu, Windows ohne WSL, läuft auch in der CI) und `backend/wsl/conout-reader.test.ts`.
- IPC, Protokoll, Datenmodell, Desktop: unverändert.
- Abhängigkeiten: keine neue.
- Security: unverändert.
- Non-Goals: das HPCON freigeben (bräuchte eine Änderung in node-pty), das Beenden vieler PTYs nacheinander (#160).
- Breaking Changes: keine.
