# Design

## Context

`bin/run-core.ts` startet bisher nur `CoreServer` mit einer Registry ohne Backend und ohne Repository. Alle Bausteine liegen auf `main`: `openStorage` und `SqliteSessionRepository` (ADR 0004), `SessionRegistry.restore()` (ADR 0005), `WslBackend` mit Keepalive und `dispose()` (ADR 0003), `CoreServer` mit Einzelinstanz über die Pipe (ADR 0001). Parallel ändert Issue #14 Handshake und Verbindungsannahme in `ipc/server.ts`.

## Goals / Non-Goals

**Goals:**

- Kein Client sieht den Zustand vor dem Reconcile; ein zweiter Core öffnet die Datenbank nicht.
- Sessions überstehen einen Core-Neustart (Abnahme 09) und einen verlorenen tmux-Client.
- Sauberer Abbau ohne hängende `wsl.exe`-Prozesse, ohne die tmux-Sessions zu beenden.

**Non-Goals:**

- Windows-Backend, Autostart, Anzeige in der Statusleiste, Wiederholen eines gescheiterten Reconcile zur Laufzeit.

## Decisions

### Startreihenfolge: Pipe, Datenbank, Reconcile, Anfragen

Die Einzelinstanz hängt an der Pipe (ADR 0001). Ein Vorab-`connect` oder eine Sperrdatei würde ein Rennen zweier gleichzeitig startender Cores offen lassen: beide öffneten und migrierten die Datenbank und hängten sich an dieselben tmux-Sessions. Deshalb belegt `runCore` zuerst die Pipe mit `CoreServer.start`, öffnet dann `openStorage`, ruft `registry.restore()` und gibt erst dann die Anfragen frei.

Dafür bekommt `CoreServer` die Option `ready: Promise<void>`. `dispatch` wartet vor jeder Anfrage außer `hello` darauf. Der Handshake bleibt unberührt (Bereich von #14), und ein früh verbundener Client bekommt seine erste `session.list` erst nach dem Reconcile. Scheitert der Start nach dem Belegen (Datenbank, Reconcile), wird `ready` mit einem `internal`-Fehler abgewiesen, der Server geschlossen und `runCore` endet mit `start_failed` (Exit-Code 1).

Die Registry braucht das Repository im Konstruktor, der Server die Registry beim Start. `run-core.ts` übergibt deshalb ein kleines weiterleitendes Repository, dessen Ziel nach `openStorage` gesetzt wird. Bis dahin wirft es; das kann nicht eintreten, weil keine Anfrage vor `ready` die Registry erreicht.

Alternative verworfen: `CoreServer` in „belegen“ und „bedienen“ teilen. Das ändert die Server-API stärker und kollidiert eher mit #14.

### `core.status` statt eines Felds in `session.list`

`backendUnavailable` beschreibt den Core, nicht die Session-Liste. Eine eigene Methode lässt `session.list` unverändert und bietet Platz für spätere Statusangaben (Version, Autostart). Ergebnis: `{ backendUnavailable: BackendKind[] }`, das Ergebnis des Reconcile beim Start. Die Registry merkt es sich (`SessionRegistry.backendUnavailable()`), damit der Server nur die Registry kennt. `PROTOCOL_VERSION` bleibt `1.0`, weil die Methode additiv ist und Phase 1 noch keinen veröffentlichten Client hat.

### Distro beim Start auflösen: optionale Backend-Methode

`Backend` erhält die optionale Methode `resolveLaunch(spec): Promise<LaunchSpec>`. Das Backend kennt seine Vorgaben (WSL: konfigurierte oder Standard-Distro über `wsl.exe -l -v`); eine Registry-Option müsste dieses Wissen in `run-core.ts` nachbauen. Die Registry ruft sie in `launch` vor `exists`/`start` auf, speichert den aufgelösten `LaunchSpec` sofort und nutzt ihn für alle weiteren Backend-Aufrufe. Scheitert das Auflösen, gilt es als gescheiterter Start (`Interrupted`, `backend_unavailable` mit Session-ID). `restart` löst ebenfalls auf, damit alte Einträge ohne Distro beim nächsten Start festgeschrieben werden. Das Reconcile löst nicht auf: Es soll eine bestehende Session finden, nicht eine Distro festlegen.

### Verlorener Client: Wiederanbinden über `exists`

Endet eine PTY ohne Exit-Code, fragt die Registry `exists`. `true` → `attach` mit der gespeicherten Größe; `false` → `Interrupted`. Eine Backend-Eigenschaft `persistent` ist nicht nötig: Ein Backend ohne Persistenz (Windows, ConPTY) meldet nach dem Ende seiner PTY `exists = false`, und die Session wird wie bisher `Interrupted`. Wirft `exists` oder `attach`, wird nach Wartezeiten (Standard 0 ms, 500 ms, 2000 ms, Option `reattachDelaysMs`) erneut versucht; nach dem letzten Versuch wird die Session `Interrupted`. Eine neu angehängte PTY, die innerhalb von 30 s wieder verloren geht, verbraucht dasselbe Versuchsbudget, damit ein sofort sterbender Client keine Endlosschleife erzeugt.

Während des Wiederanbindens bleiben Zustand, Views und Schreiber. Die Session gilt als beschäftigt (`busy = "reattach"`): `kill`, `archive` und `restart` antworten `invalid_state`, Eingaben ebenfalls (keine PTY). Nach dem Anbinden gleicht die Registry `Running`/`Detached` an die Zahl der Views an, die sich inzwischen geändert haben kann.

### `SessionRegistry.dispose()`

Beim Beenden ohne Stop müssen die PTYs (tmux-Clients) gelöst werden, ohne Zustände zu ändern: Der gespeicherte Zustand `Running`/`Detached` ist genau das, was der nächste Core abgleicht. `dispose()` löst alle PTYs (deren `dispose()` meldet kein Ende), bricht laufende Wiederanbindungen ab (eine danach noch eintreffende PTY wird sofort gelöst) und meldet keine Ereignisse mehr.

### Abbau

`close()` aus `runCore`: Server schließen → `registry.dispose()` → `dispose()` der selbst erzeugten Backends (`WslBackend`: Keepalives) → Datenbank schließen; idempotent. `core.shutdown` ruft es über `onShutdown`, SIGINT/SIGTERM direkt; danach `onExit(0)`. Signal-Handler werden beim Abbau entfernt. `beforeExit` entfällt: Solange die Pipe offen ist, leert sich die Ereignisschleife nicht, danach ist nichts mehr abzubauen.

### End-to-End-Test im selben Prozess

`runCore` mit eigenem Pipe-Namen, Temp-Datenverzeichnis und `tmuxSocket: "termdock-test"`, ohne Signal-Handler. Ein „Core-Neustart“ ist `close()` und ein neuer `runCore` auf demselben Verzeichnis. Das prüft dieselben Wege wie ein Kindprozess, lässt aber Aufräumen und Fehlersuche im Test.

## Risks / Trade-offs

- Ein Client, der während eines langsamen Reconcile (kalter WSL-Start, mehrere Sessions) anfragt, wartet entsprechend; die Desktop-App muss eine großzügige Zeitüberschreitung für die erste Anfrage wählen.
- `backendUnavailable` ist der Stand beim Start; wird WSL später erreichbar, bleibt der Wert, bis der Core neu startet.
- Während des Wiederanbindens (typisch unter 1 s) werden Eingaben mit `invalid_state` abgelehnt.
