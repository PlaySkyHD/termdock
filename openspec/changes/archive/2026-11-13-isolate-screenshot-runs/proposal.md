# Proposal

## Why

Alle Screenshot-Läufe nutzen denselben tmux-Socket `termdock-test` und dasselbe Electron-Profil. In Phase 2 laufen mehrere Agents parallel, und auch die WSL-Integrationstests verwenden `termdock-test`. Bei #27 scheiterten deshalb Läufe: Der tmux-Server eines anderen Laufs baute gerade ab, und die neuen Sessions starben mit ihm (`Interrupted`). Damit #28 und #29 parallel Screenshots aufnehmen können, braucht jeder Lauf einen eigenen Socket und ein eigenes Profil.

## What Changes

- Der isolierte Core eines Screenshot-Laufs bekommt den tmux-Socket `termdock-test-<pid>-<nonce>`, gebildet wie seine Pipe.
- Das Electron-Profil liegt je Prozess in `%TEMP%\termdock-screenshot-profile-<pid>`. Ein Lauf entfernt beim Start die Profile beendeter Läufe, so gut es geht (auch den festen Ordner älterer Stände).
- ADR 0006 und `docs/agent-lessons-learned.md` werden angepasst.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: Anforderung „Screenshot-Modus gegen isolierten Core“ (Socket je Lauf).

## Impact

- `apps/desktop/src/main/screenshot.ts` (`isolatedCore`, `screenshotProfileDir`, neu `staleProfileDirs`), `main.ts`, Tests in `screenshot.test.ts`.
- Dependencies: keine neuen. Security: Der produktive Socket `termdock` bleibt unberührt, die Profilbereinigung löscht nur Ordner mit dem festen Präfix.
