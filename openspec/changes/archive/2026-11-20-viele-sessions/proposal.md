# Proposal

## Why

Phase 4 verlangt, dass TermDock mit vielen Sessions schnell bleibt (#134). Beim Core-Start prüft der Abgleich jede gespeicherte WSL-Session einzeln mit `exists`, also mit einem `wsl.exe`-Aufruf je Session, einer nach dem anderen (`SessionRegistry.reconcileAll`). Bei 50 Sessions sind das 50 Aufrufe von je etwa 100–300 ms, bevor der Core die erste Anfrage beantwortet. Grenzwerte für Abgleich, Speicher und Eingabe-Latenz gibt es bisher nicht, und nichts misst sie.

## What Changes

- Neues optionales Backend-Mitglied `listLive(sessions)` in `packages/core/src/backend/types.ts` (gemeinsamer Baustein): liefert, welche der übergebenen Sessions noch leben, mit einem Aufruf je Gruppe statt je Session; `undefined`, wenn das Backend es nicht sagen kann.
- WSL: `listLive` mit genau einem `tmux list-sessions -F '#{session_name} #{pane_dead}'` je Distro und Socket. Lebend heißt wie bei `exists`: Session da, aktive Pane nicht tot. Die Keepalive-Buchführung bleibt wie bei `exists`: jede gefundene Session hält den Keepalive, jede fehlende gibt ihn frei, die Übernahme läuft weiter einmal je Distro.
- Der Abgleich fragt jedes erreichbare Backend mit `listLive` einmal und nutzt die Antwort statt `exists` je Session. `undefined` oder ein Fehler fällt auf den bisherigen Weg (`exists` je Session) zurück. `exists` bleibt für Einzelprüfungen (Start, Wiederanbinden, Löschen).
- Lasttest-Skript `scripts/load-test.mjs` (lokal, nicht in der CI): isolierter Core mit N Sessions (Standard 50, davon 10 mit gedrosselter Ausgabe), misst Startzeit, Abgleich beim Neustart, RSS nach 60 s und Echo-Latenz; Ergebnis als Tabelle und JSON; räumt Core, tmux-Server und Datenordner auf.
- Grenzwerte im Design: Abgleich von 50 Sessions unter 3 s, RSS des Core unter 300 MiB, Echo-Latenz p95 unter 100 ms.
- Renderer geprüft: Die Desktop-App nutzt kein WebGL-Addon von xterm.js (DOM-Renderer), verborgene Tabs halten keinen WebGL-Kontext; keine Änderung nötig.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `session-persistence`: „Reconcile beim Core-Start“ (MODIFIED): eine gebündelte Prüfung je Backend, Rückfall auf `exists`.
- `wsl-backend`: „Detach, Existenz und Wiederanbinden“ (MODIFIED) um `listLive`, „Keepalive je Distro“ (MODIFIED): auch per `listLive` gefundene Sessions halten den Keepalive; neu „Lasttest mit vielen Sessions“ (ADDED).

## Impact

- Pakete: `packages/core` (`backend/types.ts`, `backend/fake.ts`, `backend/wsl/commands.ts`, `backend/wsl/backend.ts`, `session/registry.ts`), neues Skript `scripts/load-test.mjs` mit Test in `npm run test:hooks`.
- IPC, Protokoll, Datenmodell und Desktop: unverändert.
- Security: `list-sessions` als Argument-Array wie alle tmux-Aufrufe; das Skript nutzt einen eigenen Socket `termdock-test-<pid>-<nonce>`, eine eigene Pipe und einen temporären Datenordner, nie `termdock`.
- Non-Goals: parallele `attach`-Aufrufe im Abgleich; ein Lasttest in der CI (Runner ohne WSL).
- Breaking Changes: keine. Backends ohne `listLive` verhalten sich wie bisher.
