# Design

## Kontext

node-pty 1.1.0 hält alle ConPTYs eines Prozesses in einem `std::vector` (`ptyHandles`, `conpty.cc`). Jeder Exit-Thread wartet auf seinen Prozess, schließt das Prozess-Handle und entfernt dann seinen Eintrag (`remove_pty_baton`, `erase`). Eine Sperre gibt es nicht. Auch der Hauptthread liest die Liste (`PtyKill`, `PtyResize`) und schreibt hinein (`startProcess`). Enden mehrere Prozesse gleichzeitig, ändern mehrere Threads die Liste zugleich. Das passt zum Absturzbild (0xC0000005, zufällig, häufiger mit vielen PTYs). Das `assert` um `remove_pty_baton` ist im Prebuild aktiv; sein Ausdruck steht im Binary.

Messung vor der Änderung (`scripts/pty-shutdown-repro.mjs`, 20 PTYs, je 24 Läufe, drei parallel, Node 25.2.1):

| Modus | Abstürze |
| --- | --- |
| `dispose` (alle `kill` in einem Tick) | 2 bzw. 4 von 24 |
| `kill` (alle Programme enden gleichzeitig von selbst) | 6 von 24 |

Ein gleichzeitiges natürliches Ende reicht also. Das spricht für die Liste und gegen eine Ursache nur in `kill`.

## Entscheidungen

- **Eine Schlange auf der untersten Ebene** (`CloseQueue` in `backend/wsl/close-queue.ts`, eine Instanz in `processes.ts`). Jede Stelle, die eine PTY schließt, nutzt sie: `WslPty.dispose` (Abbau, `registry.dispose`, Archivieren, Löschen, Kill, abgebrochenes Wiederanbinden) und der Verlustpfad nach einem Absturz des Lesers. Die Aufrufer bleiben unverändert. Ein Schritt ruft `kill` von node-pty nur, solange kein Exit-Code da ist, und wartet bis zum Exit-Code (Abfrage alle 10 ms). Erst dann ist der Exit-Thread fertig, und die Liste ändert sich nicht mehr.
- **Zeitlimit je PTY:** Nach 2 s ohne Exit-Code beendet der Core den Prozess über seine PID und wartet höchstens 0,5 s, dann folgt die nächste PTY. node-pty stellt `kill` bis zur ersten Ausgabe zurück, eine so frühe PTY würde sonst die Schlange halten.
- **Ende des Core:** `WslBackend.dispose` wartet auf `ptysClosed()`, höchstens 15 s, parallel zur Übergabe der Keepalives. Das ist schon heute bis zu 18 s lang. Ein `process.exit` mitten in der Schlange würde die restlichen Prozesse gleichzeitig beenden.
- **Shutdown mit Stop:** `kill-session` beendet den tmux-Client, also endet die PTY von selbst. Gleichzeitige `kill-session` lassen alle Clients zugleich enden (Modus `kill`). Nacheinander würde jede Session rund 300 ms kosten (zwei `wsl.exe`-Aufrufe zu je rund 150 ms), also 15 s bei 50 Sessions. Das liegt über dem Timeout der Anfrage von 10 s. Darum schließt `SessionRegistry.killAll` je Session zuerst die PTY. Die PTYs laufen durch die Schlange, und jede tmux-Session endet, sobald ihre PTY zu ist, während die nächste PTY schließt. Ohne Client gibt es kein natürliches Ende mehr.
- **Folge im Fehlerfall:** Scheitert in `killAll` das Ende einer tmux-Session, ist ihre PTY schon zu. Die Session wird `Interrupted` (wie jedes `kill`, das nach dem Ende der PTY scheitert, `endProcess`). Die Antwort nennt sie weiterhin als nicht beendet. Einzelne `session.kill` und `session.archive` behalten die alte Reihenfolge, dort enden keine vielen Clients gleichzeitig.
- **`PtyHandle.closed()` optional:** Backends ohne diese Methode (z. B. `FakeBackend`) gelten nach `dispose` sofort als geschlossen. Die Änderung in `backend/types.ts` ist abwärtskompatibel.

## Messung nach der Änderung

`scripts/pty-shutdown-repro.mjs`, je 50 Läufe mit 20 PTYs, drei parallel:

| Laufzeit | `dispose` | `kill` |
| --- | --- | --- |
| Node 25.2.1 | 0 Abstürze, Median 310 ms | 0 Abstürze, Median 359 ms |
| Electron 45.3.1 | 0 Abstürze, Median 311 ms | 0 Abstürze, Median 356 ms |

Mit 50 PTYs (je 10 Läufe, Node): `dispose` 776 ms, `kill` 822 ms im Median, keine Abstürze. Eine PTY braucht also rund 15 ms.

## Risiken

- Enden viele Prozesse gleichzeitig, ohne dass der Core sie beendet (z. B. Ende des tmux-Servers, `wsl --shutdown`), kann node-pty weiter abstürzen. Der Supervisor (#130) startet den Core dann neu.
- `PtyKill` liest den Eintrag, während der Exit-Thread ihn freigeben kann (`ClosePseudoConsole` beendet den Prozess vor `TerminateProcess`). Dieses Rennen betrifft eine einzelne PTY und lässt sich nur in node-pty beheben.
- Eine PTY, die nicht endet, verzögert die nächste um höchstens 2,5 s. Der Abbau des Core wartet insgesamt höchstens 15 s.
