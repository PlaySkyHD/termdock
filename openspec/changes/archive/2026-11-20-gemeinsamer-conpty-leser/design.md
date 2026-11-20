# Design

## Kontext

node-pty 1.1.0 legt je PTY in `WindowsPtyAgent` eine `ConoutConnection` an (`lib/windowsConoutConnection.js`). Sie startet einen Worker-Thread mit `lib/worker/conoutSocketWorker.js`: Er öffnet die Ausgabe-Pipe der ConPTY, legt die Named Pipe `<pipe>-worker` an und leitet weiter; der Hauptthread verbindet sich nach der Meldung `READY` mit `<pipe>-worker`. Zugleich wartet der Hauptthread in `PtyConnect` synchron in `ConnectNamedPipe`, bis der Worker die Ausgabe-Pipe geöffnet hat. Der Worker soll einen Deadlock verhindern, wenn `ClosePseudoConsole` auf das Abfließen der Ausgabe wartet (node-pty #375).

## Entscheidungen

### Ein Worker für alle PTYs

`ConoutReader` hält genau einen Worker (`new Worker(source, { eval: true, name: "termdock-conout" })`, `unref`). Nachrichten: `add { id, pipe }`, `remove { id }` an den Worker; `started`, `ready { id }`, `closed { id }` zurück. Je PTY dieselbe Weiterleitung wie node-pty (`setEncoding("utf8")`, `pipe`). Die Ersatzklasse hat die Schnittstelle, die `WindowsPtyAgent` nutzt: `onReady`, `connectSocket`, `dispose`; `dispose` wartet wie node-pty 1 s auf Restdaten und schickt dann `remove`.

Der Quelltext liegt als String im Modul, damit die Paketierung (`asarUnpack`, ADR 0007) keine weitere Datei braucht.

### Ersatz nur für 1.1.0

`installConoutReader` liest `node-pty/package.json` und ersetzt `ConoutConnection` im CommonJS-Modul `node-pty/lib/windowsConoutConnection.js`. `WindowsPtyAgent` liest die Klasse bei jedem `new` aus dem Modulobjekt, und der dynamische `import("node-pty")` des Core nutzt denselben CommonJS-Cache. Bei einer anderen Version oder ohne `ConoutConnection` meldet er einmal `conout reader: …` auf stderr und ersetzt nichts. Der Test „is the version whose ConoutConnection the reader replaces“ schlägt bei jedem Update von node-pty fehl, bis jemand den Ersatz prüft.

Verworfen: `patch-package` (neue Abhängigkeit, verändert `node_modules`), eigener Fork von node-pty (eigener Native-Build, den der Host nicht baut).

### Start erst mit laufendem Worker

`spawnConpty` wartet auf `ready()` (Meldung `started` des Workers, höchstens 10 s, danach scheitert der Start). `connect` ohne laufenden Worker wirft; node-pty bricht `spawn` dann mit einem Fehler ab, statt den Hauptthread in `ConnectNamedPipe` anzuhalten. Grenze: Stirbt der Worker genau zwischen `add` und dem Öffnen der Pipe, bleibt der Start hängen wie heute bei einem sterbenden Worker je PTY.

### Zuordnung von PTY und Verbindung

node-pty legt die Verbindung synchron in `pty.spawn` an. `spawnConpty` liest sie direkt danach mit `takeLastConnection()`; dazwischen läuft kein anderer Code.

### Absturz des Workers

Endet der Worker unerwartet (`exit` ohne `dispose`), meldet der Reader eine Zeile und feuert `onLost` jeder Verbindung. `spawnConpty` beendet dann den Prozess der PTY (`process.kill(pid)`, weil `kill` von node-pty bis zur ersten Ausgabe zurückgestellt wird) und die PTY selbst und meldet ihr Ende genau einmal: node-pty meldet es zusätzlich, weil seine Ausgabe-Socket schließt; der Wrapper meldet nur das erste. Für `WslPty` ist das ein Client-Ende ohne Exit-Code; das Backend fragt tmux, die Pane lebt, und die Registry hängt neu an (bis zu 3 Versuche, ADR 0003). Der nächste `spawnConpty` startet einen neuen Worker. Zustand, Views und Schreiber bleiben, es entsteht kein zweiter tmux-Client.

### Pipe ohne `kill`

Mit `useConptyDll` ruft node-pty `dispose` nur nach `kill` und Ausgabe auf; endet das Programm von selbst, blieb der Worker je PTY bestehen. Der gemeinsame Worker schließt eine Pipe, sobald die ConPTY ihre Ausgabe geschlossen hat und die Verbindung zum Hauptthread zu Ende ist, und meldet `closed`.

## Messung

Spike am 20.11.2026, Windows 11, Node 25.2.1 und Electron 45.3.1 als Node:

| Wert | Grenzwert | vorher Node / Electron | nachher Node / Electron |
| --- | --- | --- | --- |
| RSS 50 Sessions | < 300 MiB | 588 / 386 MiB | 88 / 71 MiB |
| Abgleich | < 3000 ms | 2969 / 2590 ms | 1484 / 1185 ms |
| Echo p95 | < 100 ms | 2,8 / 2,2 ms | 2,6 / 2,6 ms |
| RSS je PTY (`cmd.exe`) | – | 11,5 / 8,0 MiB | 0,4 / 0,4 MiB |

Die Werte der Umsetzung stehen im PR.

## Risiken

- Interne Pfade von node-pty: abgesichert durch Versionsprüfung, Test und Logzeile.
- Ein Fehler im Worker trifft alle PTYs zugleich; die tmux-Sessions überleben, der Core hängt sie neu an.
- Mehr Ausgabe über einen Thread: gemessen kein Einfluss auf das Echo (p95 2,6 ms bei 10 lauten Sessions).
