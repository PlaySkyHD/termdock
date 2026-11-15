# Proposal

## Why

Eine WSL-Session mit einem `launch.cwd`, das es in der Distro nicht gibt (etwa ein falscher Projektpfad `/srv/api`), startet bisher stillschweigend (#113, beobachtet in PR #108). `wsl.exe --cd` kann nicht wechseln, meldet `chdir(...) failed` nur im Terminal, das tmux sofort überzeichnet, und startet die Shell in `/`. Der Nutzer merkt nicht, dass sein Pfad falsch ist. Nutzerentscheidung: Die Session startet weiter, aber mit einer sichtbaren Warnung.

## What Changes

- Das WSL-Backend prüft beim Start (`session.create`, Neustart, Autostart) ein absolutes `cwd` mit `wsl.exe -d <distro> --cd ~ --exec test -d <cwd>` (Argument-Array), parallel zum ohnehin nötigen Statusaufruf. `~`, `~/…` und andere Formen prüft es nicht.
- Fehlt das Verzeichnis, startet die Session wie bisher; ihr `SessionInfo` trägt `warnings: [{ code: "cwd_missing", path, distro }]`. Ist WSL nicht erreichbar oder die Prüfung zu langsam (5 s), gibt es keine Warnung und keinen Fehler.
- Protokoll 1.5: optionales Feld `warnings` an `SessionInfo` (Antworten auf `session.create` und `session.list`, Events) und an `session.stateChanged`. Warnungen gehören zum laufenden Lauf: gesetzt beim Binden der PTY, nur in `Running`/`Detached`, nicht gespeichert.
- Desktop: Ein Hinweis oben im Pane nennt Pfad, Distro und den tatsächlichen Ort der Shell: „Verzeichnis /srv/api fehlt in Ubuntu – die Session läuft im Wurzelverzeichnis /.“ Er lässt sich schließen (bis zum nächsten Start der Session) und blockiert keine Eingabe.
- Screenshot-Szenen `70-cwd-missing-warning.png` und `71-cwd-warning-dismissed.png`.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `wsl-backend`: neue Anforderung „Prüfung des Arbeitsverzeichnisses beim Start“ (ADDED).
- `session-lifecycle`: neue Anforderung „Warnungen des laufenden Laufs“ (ADDED).
- `ipc-protocol`: neue Anforderung „Warnungen einer Session im Vertrag“ (ADDED); „WSL-Distributionen im Vertrag“ (MODIFIED, Versionsszenario gilt ab 1.4 statt genau 1.4).
- `desktop-shell`: neue Anforderung „Hinweis bei fehlendem Arbeitsverzeichnis“ (ADDED).

## Impact

- Pakete: `packages/protocol` (`SessionWarning`, `SessionInfo.warnings`, `session.stateChanged.warnings`, Guards, `PROTOCOL_VERSION` 1.5), `packages/core` (WSL-Backend, `PtyHandle.warnings` in `backend/types.ts`, Registry, Server, Repository ohne Warnungen, `FakeBackend.missingCwds`), `apps/desktop` (Brücke, Store, Pane-Hinweis, Szene `screenshot-cwd.ts`).
- IPC: `session.create`, `session.list`, `session.created`, `session.updated`, `session.stateChanged`. Keine neue Methode.
- Datenmodell: SQLite unverändert (Warnungen sind Laufzeitzustand).
- Phase: Fehlerbehebung zu Phase 3 (Projekte und Profile, Kapitel 12 des Konzepts).
- Non-Goals: Projekte bei `project.create`/`project.update` prüfen; Starts ablehnen (`invalid_cwd`); Windows-Pfade prüfen; `~/…` auflösen; Warnungen speichern oder in der Sidebar zeigen.
- Security: Die Prüfung ist ein Argument-Array ohne Shell (`test -d <cwd>`), der Pfad geht nie in einen Shell-String. Der Pfad im Hinweis ist Text, kein HTML.
- Breaking Changes: keine. Ältere Clients ignorieren das neue Feld; ein Core 1.4 sendet es nicht. Die Prüfung kostet je Start einen parallelen `wsl.exe`-Aufruf (gemessen ca. 30 ms im Median).
