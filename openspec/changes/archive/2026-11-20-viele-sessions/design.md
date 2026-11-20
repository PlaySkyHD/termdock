# Design

## Kontext

Der Abgleich beim Core-Start (`SessionRegistry.reconcileAll`) prüft jede gespeicherte Session in `Starting`, `Running` oder `Detached` einzeln: `exists` (ein `wsl.exe … tmux has-session ; display-message`), danach `attach` (eine PTY). Beides läuft nacheinander, damit ein langsames WSL nicht mit vielen parallelen Aufrufen getroffen wird. Der Core beantwortet bis zum Ende des Abgleichs nur `hello`.

## Entscheidungen

### `listLive` als optionales Backend-Mitglied

`Backend.listLive(sessions: readonly { id, spec }[]): Promise<ReadonlySet<SessionId> | undefined>`. Die Sessions werden übergeben, weil das Backend nicht weiß, welche Distros gespeicherte Sessions nutzen, und eine Session nur in ihrer eigenen Distro als lebend zählen darf. Das Ergebnis enthält nur IDs aus der Eingabe. `undefined` heißt „kann ich nicht sagen“; der Abgleich fällt dann auf `exists` je Session zurück und meldet ein nicht erreichbares Backend wie bisher über dessen Fehler. Optional, damit Backends ohne Bündelung (Windows, Tests) unverändert bleiben. Gemeinsamer Baustein nach `docs/agent-lessons-learned.md`, Abschnitt 1: im PR ausdrücklich benannt.

### WSL: ein `list-sessions` je Distro

`tmux -L <socket> list-sessions -F '#{session_name} #{pane_dead}'` (Argument-Array, aus `~`). `pane_dead` im Kontext von `list-sessions` ist die aktive Pane des aktiven Fensters, dieselbe, die `exists` über `display-message -t =<name>:` liest. Lebend = Zeile `td-<id> 0`. Zeilen anderer Form (Meldungen von `wsl.exe`) werden verworfen. „no server running“ / „error connecting“ (`isMissingSession`) ergibt eine leere Menge. Ein anderer Fehler in einer Distro macht die ganze Antwort `undefined`; gemischte Antworten (eine Distro gebündelt, eine einzeln) wären möglich, lohnen aber den zusätzlichen Vertrag nicht.

### Keepalive-Buchführung

`exists` hält seit #140 den Keepalive für eine gefundene Session (`retain`) und gibt ihn für eine fehlende frei (`release`). `listLive` macht genau dasselbe für jede übergebene Session, aber erst, wenn alle Distros geantwortet haben; bei `undefined` ändert es nichts, und die folgenden `exists`-Aufrufe übernehmen die Buchführung. Die Übernahme verbliebener Keepalives (`takeOverOnce`) hängt an der Distro, nicht an der Zahl der `retain`-Aufrufe, läuft also weiter einmal je Distro. Das anschließende `attach` ruft `retain` für dieselbe Session erneut auf; die Menge in `DistroKeepalive` macht das idempotent.

### Abgleich

`reconcileAll` sammelt vor der Schleife je Backend die abzugleichenden Nicht-Windows-Sessions, prüft die Verfügbarkeit (dieselbe gecachte Prüfung wie bisher) und fragt `listLive` einmal. In `reconcile` ersetzt die Antwort nur den `exists`-Aufruf; `attach`, Zustände, Speichern und das Verhalten nach `dispose` bleiben unverändert. Die `attach`-Aufrufe bleiben nacheinander (Non-Goal, siehe unten).

### Lasttest

`scripts/load-test.mjs` startet `packages/core/dist/bin/termdock-core.js` als eigenen Prozess wie die Desktop-App, mit `TERMDOCK_PIPE`, `TERMDOCK_DATA_DIR` (Temp) und `TERMDOCK_TMUX_SOCKET`. Abweichend von der Issue-Skizze (`termdock-load`) nutzt es einen Socket nach dem Schema `termdock-test-<pid>-<nonce>`: Bricht ein Lauf hart ab, räumt `cleanStaleWslTestServers` des nächsten WSL-Testlaufs ihn mit auf. Die lauten Sessions laufen `sh -c 'while :; do yes | head -n 200; sleep 0.1; done'` (etwa 4 KB/s je Session), die ruhigen `sh`. Die Sessions werden nacheinander angelegt. Gemessen werden:

- Start: erstes `session.create` bis alle Sessions laufen (`Detached` ohne View);
- Abgleich: `hello` beantwortet bis zur ersten Antwort auf `session.list` nach `core.shutdown { stopSessions: false }` und Neustart;
- RSS: Working Set des Core-Prozesses nach 60 s mit laufender Ausgabe;
- Echo: 40 einzelne Zeichen an eine ruhige Session, Zeit bis zur Ausgabe, die das Zeichen enthält.

Am Ende: Core beenden, `tmux -L <socket> kill-server` (beendet Sessions und Keepalive), Datenordner löschen; auch nach einem Fehler und bei Ctrl+C.

## Grenzwerte und Messung

Gemessen am 20.11.2026 auf dem Entwickler-PC (Windows 11, WSL 2, Ubuntu 26.04, tmux 3.6, Node 25), 50 Sessions, davon 10 laut:

| Wert | Grenzwert | vorher | nachher |
| --- | --- | --- | --- |
| Abgleich beim Neustart | < 3 s | 12 189 ms | 2 902 ms |
| Neustart bis bereit | – | 12 635 ms | 3 339 ms |
| Start bis alle laufen | – | 13 546 ms | 13 304 ms |
| RSS des Core nach 60 s | < 300 MiB | 582 MiB | 579 MiB |
| Echo p50 / p95 / max | p95 < 100 ms | 1,9 / 4,5 / 9,7 ms | 1,6 / 2,1 / 3,0 ms |

Nach der Bündelung kostet der Abgleich noch etwa 55 ms je Session, fast nur für die PTY des `attach` (ConPTY und `wsl.exe`).

RSS liegt über dem Grenzwert. Ursache: node-pty 1.1.0 startet unter Windows je PTY einen eigenen Worker-Thread (`ConoutConnection`, `lib/windowsConoutConnection.js`), also eine eigene V8-Instanz. Nachgemessen ohne WSL: 20 PTYs mit `cmd.exe` heben den RSS eines Node-Prozesses von 52 auf 286 MiB, etwa 11,7 MiB je PTY. Bei 50 Sessions sind das rund 580 MiB, unabhängig von der Bündelung. Die Behebung (z. B. keine PTY für Sessions ohne View, oder ein PTY-Weg ohne Worker je Session) ändert den Lifecycle oder die PTY-Schicht und kommt in ein Folge-Issue.

## Renderer

`apps/desktop` nutzt `@xterm/xterm` mit `@xterm/addon-fit`, aber kein `@xterm/addon-webgl`; xterm.js rendert damit über das DOM. Verborgene Tabs halten keinen WebGL-Kontext, die Chromium-Grenze von 16 Kontexten greift nicht. Keine Änderung.

## Non-Goals

- Parallele oder verzögerte `attach`-Aufrufe im Abgleich: würde die Grenze von 3 s mit Reserve einhalten, ändert aber die Last auf WSL und die Reihenfolge der Zustände; Folge-Issue zusammen mit dem Speicher.
- Lasttest in der CI (Runner ohne WSL).
