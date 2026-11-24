# Design

## Kontext

node-pty 1.1.0 mit `useConptyDll` (`lib/windowsPtyAgent.js`, `src/win/conpty.cc`):

- **Eingabe-Pipe:** `_inSocket` ist ein `net.Socket` auf der Pipe `conin`, geöffnet mit `fs.openSync`. Geschlossen wird er nur in `WindowsPtyAgent.kill` (`this._inSocket.destroy()`). `_$onProcessExit` und `_cleanUpProcess` tun mit `useConptyDll` nichts.
- **HPCON:** Der Eintrag `pty_baton` hält `hpc`. Nach dem Start ruft `PtyConnect` `ConptyReleasePseudoConsole(hpc)` auf, damit OpenConsole mit seinem letzten Client endet. Freigeben kann das HPCON nur `ConptyClosePseudoConsole` in `PtyKill`. Der Exit-Thread (`SetupExitCallback`) wartet auf den Prozess und schließt `hShell`. Dann entfernt er den Eintrag (`remove_pty_baton`, der Eintrag hat keinen Destruktor, der `hpc` schließt). Erst danach meldet er den Exit-Code an JavaScript.

Gemessen mit `(Get-Process -Id <pid>).HandleCount`: 20 PTYs mit `cmd /c echo x` hinterlassen 60 Handles, nur mit dem Schließen der Eingabe-Pipe 40. Mit `kill` sind es 0.

## Entscheidungen

- **Eingabe-Pipe beim Ende:** `end()` in `endOnLoss` schließt `_inSocket`, bevor es das Ende meldet. `end()` läuft genau einmal je PTY, nach einem natürlichen Ende, nach einem Verlust und nach einer gescheiterten Weiterleitung. Der Prozess ist dann schon beendet, keine Eingabe kann ihn mehr erreichen. Ein Ende ohne Exit-Code (Ausgabe-Socket zuerst geschlossen) wartet wie bisher bis zu 1 s auf den Exit-Code und schließt sonst den Prozess.
- **Verbindung des Lesers beim Schließen:** `close()` ruft `ConoutConnection.close()` auf, bevor es das Ende meldet. Der Worker entfernt die Pipe sonst erst, wenn auch der Client von `<pipe>-worker` gegangen ist (`closeWhenDrained`). Die Probe ergab: Unter Windows schließt der Worker die Pipe nach dem Ende der Ausgabe auch dann, wenn ein Client in einem anderen Prozess seine Seite offen hält (`allowHalfOpen`). Den beschriebenen Rückstand gab es so nicht. Der Aufruf macht das Schließen trotzdem unabhängig vom Client, und nach einem verlorenen Worker tut er nichts (`fireLost` setzt `ended`).
- **HPCON bleibt (Grenze):** Aus JavaScript ist das HPCON nur über `PtyKill` erreichbar, und nur solange der Eintrag besteht. Vor dem Exit-Code rennt `ClosePseudoConsole` mit dem Exit-Thread, der den Eintrag gerade freigibt. In PR #167 brachte genau das den Testprozess zum Absturz. Nach dem Exit-Code ist der Eintrag entfernt, und `PtyKill` tut nichts. Einen Zeitpunkt dazwischen gibt es für JavaScript nicht, ebenso keine andere API. Sicher freigeben ließe es sich nur in node-pty, etwa mit `ClosePseudoConsole` im Exit-Thread vor `remove_pty_baton`. Das braucht einen Fork oder Patch, ADR 0008 hat beides verworfen. Es bleiben rund 2 Handles je natürlich endender PTY, ebenso je PTY nach einem Absturz des Workers.

## Risiken

- In einem Core, der wochenlang läuft, wachsen die Handles weiter: 2 je Ende eines tmux-Clients oder erneutem Anhängen. Bei 1000 solchen Enden sind das rund 2000 Handles, weit unter der Grenze von Windows je Prozess. Ein Neustart des Core gibt sie frei; die Sessions bleiben in tmux.
