# Proposal

## Why

Phase 1 hat alle Bausteine des Core einzeln geliefert (Protokoll, Registry, Storage mit Reconcile, IPC-Server, WSL-Backend), aber `termdock-core` setzt sie noch nicht zusammen: Der Prozess startet ohne Backend und ohne Datenbank, Sessions überleben keinen Core-Neustart, und Abnahme 09 (verlorene Prozesse erscheinen als `Interrupted`) ist nur in Teilen geprüft. Dazu kommen zwei Lücken aus dem Review von PR #12: Ohne gespeicherte Distro sucht ein Core nach `wsl --set-default` die Sessions in der falschen Distro, und ein verlorener tmux-Client macht eine lebende Session fälschlich `Interrupted` (Issue #13).

## What Changes

- `runCore` belegt zuerst die Pipe, öffnet danach die Datenbank (`openStorage`, Datenverzeichnis per Option oder `TERMDOCK_DATA_DIR`), registriert das `WslBackend` (tmux-Socket per Option, Standard `termdock`), gleicht mit `registry.restore()` ab und beantwortet erst danach Anfragen. Ein zweiter Core meldet `already_running`, ohne die Datenbank zu öffnen.
- `CoreServer` erhält die Option `ready`: `hello` wird sofort beantwortet, alle weiteren Anfragen warten, bis `ready` erfüllt ist.
- Neue IPC-Methode `core.status` mit dem Ergebnis `{ backendUnavailable: BackendKind[] }` aus dem Reconcile; `session.list` bleibt unverändert. `backend_unavailable` wird zusätzlich auf stderr protokolliert.
- Abbau bei `core.shutdown`, SIGINT und SIGTERM: Server schließen, Registry freigeben (PTYs lösen, Zustände bleiben), `WslBackend.dispose()` (Keepalives enden, tmux-Sessions bleiben), Datenbank schließen.
- Die Registry löst beim Start einer Session fehlende Backend-Vorgaben über die neue optionale Backend-Methode `resolveLaunch` auf und speichert sie im `LaunchSpec` (WSL: Standard-Distro).
- Endet eine PTY ohne Exit-Code, prüft die Registry `exists` und hängt sich neu an (höchstens 3 Versuche mit Wartezeit); Zustand, Views und Schreiber bleiben. Nur wenn das scheitert oder die Backend-Session fehlt, wird die Session `Interrupted`.
- Neue Methode `SessionRegistry.dispose()`: löst alle PTYs, ohne Zustände zu ändern oder ein Wiederanbinden auszulösen.
- ADR 0003 wird um die Präzisierungen aus #4 ergänzt, ADR 0001 um die Startreihenfolge.
- End-to-End-Test hinter `TERMDOCK_WSL_TESTS=1` (Abnahme 09 und Wiederanbinden nach `tmux detach-client`).

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `core-ipc`: Startreihenfolge und Einzelinstanz vor der Datenbank, Zurückhalten von Anfragen bis zum Ende des Reconcile, `core.status`, Abbau.
- `session-lifecycle`: Ende der PTY ohne Exit-Code führt zuerst zum Wiederanbinden; Auflösen und Speichern der Backend-Vorgaben beim Start; Freigeben der Registry.
- `ipc-protocol`: Methode `core.status`.

## Impact

- `packages/core/src/bin/run-core.ts` (Zusammensetzung, Abbau), `src/session/registry.ts` (`resolveLaunch`, Wiederanbinden, `dispose`), `src/backend/types.ts` (optionale Methode `resolveLaunch`), `src/backend/fake.ts` (Steuerung für verlorenen Client und Standard-Distro), `src/backend/wsl/backend.ts` (`resolveLaunch`), `src/ipc/server.ts` (Option `ready`, Fall `core.status`), Exporte in `src/index.ts` unter `// assembly`.
- `packages/protocol`: neue Methode `core.status` mit Guard. `PROTOCOL_VERSION` bleibt `1.0`: Die Methode ist additiv und Phase 1 ist nicht veröffentlicht.
- Paralleles Issue #14 ändert Handshake und Verbindungsannahme in `ipc/server.ts`; diese Änderung berührt nur `dispatch` und die Optionen.
- Dependencies: keine neuen.
- Non-Goals: Windows-Backend, Autostart, Statusleiste in der UI, Verlauf auf der Platte.
- Security: keine neuen Eingänge außer `core.status` ohne Parameter; Befehle an `wsl.exe`/`tmux` bleiben Argument-Arrays.
