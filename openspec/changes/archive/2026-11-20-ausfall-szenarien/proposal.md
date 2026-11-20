# Proposal

## Why

Phase 4 verlangt, dass typische Ausfälle zu einem korrekten Zustand ohne Datenverlust führen, und Tests belegen das (Issue #133). Bisher deckten Tests einzelne Bausteine ab (Reconcile bei nicht erreichbarem Backend, Schreibfehler des Verlaufs, Lösen der Views beim Neuladen), aber keiner spielte die fünf Ausfälle als Ganzes durch: tmux-Server stirbt, Core wird hart beendet, Renderer stürzt ab, WSL beim Start nicht erreichbar, Datenordner schreibgeschützt oder voll.

Beim Durchspielen fiel ein Fehler auf: Kann der Verlauf nicht geschrieben werden (volle Platte, schreibgeschützter Ordner), schrieb der Core bei jedem Schreibversuch (alle 25 ms je Session mit Ausgabe) eine Zeile ins Log. Das Log rotiert bei 1 MiB und hätte die übrigen Diagnosezeilen nach wenigen Minuten verdrängt.

## What Changes

- Je Szenario ein Test:
  1. `packages/core/src/failure.wsl.test.ts` (nur mit `TERMDOCK_WSL_TESTS=1`): `tmux -L <eigener Socket> kill-server` bei laufenden Sessions mit Views; danach `Interrupted`, Event an die Views, Eingabe abgelehnt, kein `wsl.exe` und kein tmux-Prozess des Sockets übrig; `restart` startet die Session neu.
  2. `packages/core/src/bin/hard-kill.test.ts`: Der Core läuft als eigener Prozess (`dist/test/flooding-core.js`, FakeBackend mit Dauerausgabe), ein Client speichert das Layout fortlaufend, der Test beendet den Prozess hart; danach `PRAGMA integrity_check` = ok, Verlauf lesbar und im Limit, Layout mit genau der Revision seines Dokuments.
  3. Screenshot-Gruppe `crash` (`screenshot-crash.ts`, Bilder `31-…` bis `33-…`): `forcefullyCrashRenderer()` im schreibenden Fenster, das andere Fenster übernimmt die Eingabe und schreibt, das neu geladene Fenster hängt sich als Leser wieder an.
  4. `packages/core/src/bin/failure-scenarios.test.ts`: FakeBackend mit `available()` = `false` beim Start; Sessions `Interrupted`, `core.status` meldet `wsl`, nichts wird angehängt oder gestartet. Der Hinweis in der UI ist im Test von `coreHints` belegt.
  5. Ebenda: Datenbank verweigert jedes Schreiben (eingeschleuster SQLite-Fehler über die neue Option `RunCoreOptions.openStorage`), `history/` lässt sich nicht anlegen; der Core antwortet mit `internal`, läuft weiter, die Session liefert weiter Ausgabe und Ende.
- Fix: `HistoryStore` meldet einen Schreibfehler je Session nur einmal, bis wieder ein Schreiben gelingt; verworfene Einträge zählt er weiter.
- `docs/acceptance.md`: neue Nachweise unter V1-09. Doku der Szenengruppen nennt `crash`.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `session-lifecycle`: Ende der PTY, wenn der tmux-Server stirbt.
- `wsl-backend`: PTY-Ende, wenn der tmux-Server stirbt, ohne übrige Prozesse.
- `history`: Schreibfehler einmal je Fehlerstrecke melden.
- `session-persistence`: Speicherfehler bei voller Platte; Daten nach hartem Ende des Core.
- `desktop-shell`: abgestürzter Renderer gibt das Schreibrecht frei; Screenshot-Gruppe `crash`.

## Impact

`packages/core` (Fix in `storage/history-store.ts`, Option `openStorage` in `bin/run-core.ts`, neue Tests und `src/test/flooding-core.ts`), `apps/desktop` (neue Szenengruppe), Docs. Protokoll und IPC bleiben unverändert; Speicherfehler kommen weiter als `internal` an.
