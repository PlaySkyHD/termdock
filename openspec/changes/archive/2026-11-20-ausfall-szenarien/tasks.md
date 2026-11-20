# Tasks

## 1. tmux-Server stirbt

- [x] 1.1 `kill-server` auf dem eigenen Socket: Sessions `Interrupted`, Event an den Client mit Views, Eingabe `invalid_state`, kein Prozess des Sockets in Linux und Windows (Test `failure.wsl.test.ts`: `[V1-09] makes every session Interrupted, tells the attached views and leaves no PTY behind`)
- [x] 1.2 `restart` nach dem Tod des Servers startet die Session neu, die View bleibt Schreiber (Test `failure.wsl.test.ts`: `[V1-09] starts an Interrupted session again after the server died, with its view as writer`)

## 2. Core wird hart beendet

- [x] 2.1 Einstieg `src/test/flooding-core.ts` mit Dauerausgabe; Kill während Verlauf und Layout schreiben; danach Integrität, Verlauf im Limit, Layout mit seiner Revision, nächster Core meldet `Interrupted` (Test `bin/hard-kill.test.ts`: `[V1-11] leaves a readable database, a readable history within the limit and no half-saved layout`)

## 3. Renderer stürzt ab

- [x] 3.1 Screenshot-Gruppe `crash` mit `31-crash-input-free.png`, `32-crash-other-window-writes.png`, `33-crash-reloaded-reader.png`, je mit Sichtbarkeitsselektor (Lauf `npm run screenshot -w apps/desktop -- <dir> --scenes crash`; Test `screenshot.test.ts`: Reihenfolge `crash` vor `restart`; `scene-prefixes.test.ts`: eindeutige Präfixe)

## 4. WSL beim Start nicht erreichbar

- [x] 4.1 FakeBackend mit `available()` = `false`: Sessions `Interrupted`, `core.status` meldet `wsl`, kein Attach und kein Start (Test `bin/failure-scenarios.test.ts`: `[V1-09] makes the stored sessions Interrupted and reports backend_unavailable without touching WSL`)
- [x] 4.2 Hinweis „WSL nicht erreichbar“ in der UI (Test `session-display.test.ts`: `[V1-09] warns about each backend the core could not reach`)

## 5. Datenordner schreibgeschützt oder voll

- [x] 5.1 Option `RunCoreOptions.openStorage`; Schreibfehler der Datenbank ergeben `internal`, der Core läuft weiter, die Session liefert Ausgabe, Eingabe und Ende; nach freiem Platz wird wieder gespeichert (Test `bin/failure-scenarios.test.ts`: `answers failed writes with internal and keeps running; a session without history goes on`)
- [x] 5.2 Fix: Schreibfehler des Verlaufs einmal je Fehlerstrecke melden (Test `history-store.test.ts`: `reports a failing write once until a write of the session succeeds again (issue #133)`; ohne Fix rot)

## 6. Doku

- [x] 6.1 `docs/acceptance.md` V1-09, Szenengruppe `crash` in `AGENTS.md` und `docs/agent-lessons-learned.md` (Prüfung `npm run acceptance`)
