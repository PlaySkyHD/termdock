# Proposal

## Why

Jeder Screenshot-Lauf nutzt einen eigenen tmux-Socket `termdock-test-<pid>-<nonce>`. Bricht ein Lauf ab (Absturz, Timeout, Prozess hart beendet), bleiben tmux-Server und Sessions in WSL bestehen, und niemand kennt den Socket (Issue #38).

## What Changes

- Beim Start eines Screenshot-Laufs sucht die App in den tmux-Socket-Verzeichnissen von WSL nach Sockets `termdock-test-<pid>-<nonce>` von nicht mehr laufenden Prozessen (dieselbe Prüfung „Prozess läuft noch“ wie bei den alten Electron-Profilen) und beendet deren Server mit `tmux -L <socket> kill-server`.
- Die Namensprüfung ist strikt; `termdock`, `termdock-test`, der eigene Socket und Sockets laufender Prozesse bleiben unberührt.
- Fehler beim Aufräumen werden geloggt und brechen den Lauf nicht ab.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: neue Anforderung „Screenshot-Modus räumt verwaiste tmux-Sockets auf“.

## Impact

- `apps/desktop/src/main/screenshot.ts` (reine Auswahl, Aufräumen mit Seam, WSL-Teil), `screenshot.test.ts`, `main.ts` (Aufruf).
- Dependencies: keine. Non-Goals: Szenen, Renderer, Core, andere Sockets als `termdock-test-<pid>-<nonce>`.
- Security: `wsl.exe` und `tmux` bekommen ausschließlich Argument-Arrays; `kill-server` trifft nur Namen, die exakt dem Muster entsprechen und wird immer mit `-L` aufgerufen.
- Breaking Changes: keine.
