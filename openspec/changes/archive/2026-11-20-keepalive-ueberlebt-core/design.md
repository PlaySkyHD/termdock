# Design

## Kontext

WSL beendet eine Distro samt tmux-Server, wenn etwa 8–20 s lang kein `wsl.exe` läuft (ADR 0003, Phase 0). Der Core hält deshalb je Distro einen Keepalive. libuv legt unter Windows für alle Kindprozesse, die nicht `detached` starten, ein Job-Objekt mit `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` an; endet der Core, beendet Windows sie mit. Nachgemessen (Node 25, Windows 11): Ein `wsl.exe` ohne `detached` endete mit dem per `Stop-Process -Force` beendeten Elternprozess, mit `detached` lief es weiter, ohne Fenster (`MainWindowHandle` 0). Das NSIS-Update beendet nur Prozesse unter `$INSTDIR`; `wsl.exe` liegt in `System32` und ist nicht betroffen.

## Entscheidungen

### Variante A: Keepalive außerhalb des Core

Gewählt ist Variante A aus #140: Der Core startet den Keepalive `detached` (`spawn(..., { detached: true, stdio: "ignore", windowsHide: true })`, danach `unref()`). Er überlebt jedes Ende des Core, auch Absturz, Task-Manager und Update.

Verworfen: Variante B (der Installer ruft vor dem Kill `core.shutdown { stopSessions: false }` und startet einen befristeten Halte-Prozess). Sie deckt nur Update und Deinstallation ab, nicht Abstürze, braucht NSIS-Makros und eine feste Frist.

### Keepalive als wartender tmux-Client

Der Keepalive ist `wsl.exe -d <distro> --cd ~ --exec tmux -L <socket> wait-for termdock-keepalive`. Den Kanal löst niemand aus. Gemessen mit tmux 3.6:

- Der Client braucht kein Terminal, `list-clients` zeigt ihn nicht (Neuzeichnen und Größen bleiben unberührt), und seine Befehlszeile bleibt in `/proc/<pid>/cmdline` unverändert.
- Endet die letzte Session des Sockets, beendet sich der tmux-Server und weckt vorher alle wartenden Clients; der Keepalive endet und mit ihm sein `wsl.exe`.
- Wird sein `wsl.exe` beendet (`kill()` des Backends), endet auch der Linux-Prozess.

Gegenüber `sleep infinity` hat das zwei Vorteile: Ein verwaister Keepalive endet von selbst, sobald der tmux-Server endet (Grenze unten), und seine Befehlszeile ist eindeutig, so dass ein späterer Core genau ihn findet. Startet der Keepalive für die erste Session, bevor `new-session` den Server angelegt hat, endet er sofort („no server running“); der bestehende Neustart mit Backoff startet ihn nach 1 s erneut, WSL bleibt währenddessen durch die PTY wach.

### Übernahme statt PID-Datei

Der nächste Core muss den alten Keepalive finden, damit nicht zwei laufen. Verworfen: PID-Datei im Datenordner. Eine Windows-PID kann nach dem Ende des Prozesses neu vergeben sein; sie sicher einem `wsl.exe` zuzuordnen, bräuchte Startzeit und Befehlszeile per PowerShell/WMI, und ein Irrtum beendet einen fremden Prozess. Ein beobachteter fremder Prozess bräuchte zudem Polling, um sein Ende zu bemerken.

Stattdessen beendet `DistroKeepalive` vor dem ersten Start je Distro (einmal je Instanz, Option `takeOver`) die verbliebenen Keepalives: `wsl.exe -d <distro> --cd ~ --exec pkill -x -f "tmux -L <socket> wait-for termdock-keepalive"`. `-x` verlangt die ganze Befehlszeile, der Socket-Name ist ein einfaches Wort ohne Regex-Syntax. Erst wenn der Aufruf zurück ist (Erfolg, `1` = keiner lief, Fehler oder Timeout), startet der eigene Keepalive. Zwei laufen so nie gleichzeitig; die Lücke dazwischen ist wenige Millisekunden lang, und der `pkill`-Aufruf selbst ist ein `wsl.exe`. Eine Session, die während der Übernahme freigegeben und wieder gehalten wird, wartet auf dieselbe Übernahme, damit sie nie den eigenen Keepalive trifft. Spätere Starts derselben Instanz (Neustart nach Backoff, neue erste Session) übernehmen nicht erneut: Einen fremden Keepalive kann es dann nicht mehr geben, weil nur ein Core die Pipe hält (ADR 0001).

Die Formulierung „findet den alten Keepalive und startet keinen zweiten“ aus #140 ist damit so umgesetzt: Der neue Core ersetzt den alten, es laufen nie zwei.

### Abbau

`WslBackend.dispose()` lässt laufende Keepalives laufen, stoppt Neustart-Timer und startet keine neuen. Das gilt für `core.shutdown` ohne `stopSessions`, SIGINT und SIGTERM: Die tmux-Sessions sollen bleiben (ADR 0001), also muss WSL wach bleiben. Mit `stopSessions: true` beendet der Core vorher alle Sessions; jede `kill`-Freigabe beendet den Keepalive mit der letzten Session, spätestens endet er mit dem tmux-Server.

### Grenze

Ohne Core hält der verwaiste Keepalive WSL wach, solange auf dem Socket Sessions leben, also unbegrenzt, bis die Programme enden, der Nutzer die Sessions beendet, Windows neu startet oder `wsl --shutdown` läuft. Das ist gewollt (die Sessions sollen überleben) und steht in ADR 0003. Mehrere Distros haben je einen eigenen Keepalive.

## Risiken

- Fehlt `pkill` in einer Distro, scheitert die Übernahme; der Keepalive startet trotzdem, ein verwaister läuft daneben weiter, bis der tmux-Server endet.
- Eine eigene `exit-empty off` in der tmux-Konfiguration des Nutzers lässt den Server ohne Sessions weiterlaufen; ein verwaister Keepalive lebt dann bis zur nächsten Übernahme.
- Ein Nutzer, der selbst `tmux -L termdock wait-for termdock-keepalive` startet, verliert diesen Prozess beim nächsten Core-Start.

## Tests

- Unit (`commands.test.ts`): Argumente von Keepalive und Übernahme, Ablehnung eines Socket-Namens mit Regex-Zeichen.
- Unit (`keepalive.test.ts`): Übernahme einmal je Distro vor dem ersten Start, Start trotz gescheiterter oder werfender Übernahme, kein Start nach Freigabe oder `dispose` während der Übernahme, erneut gehaltene Session wartet auf dieselbe Übernahme; `dispose` lässt laufende Prozesse laufen und verhindert Start und Neustart.
- Unit (`backend.test.ts`): `pkill`-Aufruf je Distro einmal vor dem ersten Keepalive; `dispose` lässt die Keepalives laufen.
- WSL-Integrationstest (`keepalive.wsl.test.ts`, `TERMDOCK_WSL_TESTS=1`): echter Core als eigener Prozess aus `dist` auf eigenem Pipe-Namen, Datenordner und Socket; Session anlegen, Core per Kill beenden, 30 s warten, derselbe Keepalive-Prozess lebt und die Session existiert; drei Neustarts mit Kill, danach genau ein Keepalive, jeweils ein neuer Prozess; `core.shutdown { stopSessions: true }` hinterlässt keinen. Ohne `detached` ist der Test rot (nachgeprüft).
