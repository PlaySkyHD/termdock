# Design

## Kontext

ADR 0003 legt fest: Die PTY führt die Windows-Shell direkt aus, der Rohpuffer von 256 KiB ist der Snapshot. ADR 0005 macht Windows-Sessions beim Abgleich ohne Backend-Aufruf `Interrupted`. Die Registry, der Abgleich, der Autostart, der Verlauf und der Rohpuffer sind schon backend-neutral. Es fehlt das Backend selbst, und der ConPTY-Code liegt unter `backend/wsl/`.

## Entscheidungen

- **Gemeinsamer ConPTY-Code nach `backend/conpty/`.** `spawnConpty`, Leser, Schließ-Schlange und `ConptyPty` (die DA1-Antwort) gehören keinem Backend. Verschoben mit `git mv`, nicht kopiert; `wsl/processes.ts` behält `runWsl`, den Keepalive und `spawnPty`. `ConptyPty` reicht das Ende-Ereignis an `resolveEnd` weiter: WSL fragt tmux, Windows nimmt den Exit-Code.
- **Verlust als `lost`.** Nach einem Verlust der Ausgabe (Absturz des Lesers, fremder Client auf der Relay-Pipe) beendet `spawnConpty` den Prozess selbst; dessen Exit-Code sagt dann nichts über die Shell. Das Ereignis trägt `lost: true`, das Windows-Backend meldet es ohne Exit-Code, und die Registry setzt `Interrupted`, weil `exists` falsch ist. Ein Rennen fiel dabei auf: Das eigene Ende-Ereignis von node-pty kam gelegentlich vor dem Schließen an und meldete das Ende ohne `lost`. Solange ein Schließen läuft, meldet nur dieses.
- **Shell-Suche im Backend.** Mit einem vollen Pfad hängt der Start nicht vom Suchpfad von `CreateProcess` ab, und eine fehlende Shell ergibt eine klare Meldung statt eines Fehlers von node-pty. Bekannte Orte zuerst, dann absolute `PATH`-Einträge; relative Einträge würden im Arbeitsverzeichnis des Core suchen. Ohne Wahl pinnt `resolveLaunch` `pwsh`, sonst `powershell`; die Registry speichert sie wie die Distro.
- **Fehlertext an den Client.** Die Registry verpackte jeden Startfehler als „Session … could not be started“. Ein `CoreError` des Backends trägt einen Text für den Benutzer und wird angehängt; andere Fehler bleiben in `cause`, weil node-pty- oder `wsl.exe`-Meldungen Befehlszeilen enthalten können.
- **`kill` wartet auf das gemeldete Ende.** Beim Test von `core.shutdown { stopSessions }` mit echtem `cmd.exe` scheiterte der Stop: `killAll` gibt die PTY frei und wartet auf `closed()`, das den Exit-Code per Abfrage sieht, bevor node-pty das Ende meldet. Der Eintrag in `live` war dann noch da, und `kill` meldete „still runs“. `kill` wartet jetzt auf das Ende-Ereignis des Prozesses und auf die Meldung an die Registry, höchstens 1 s.
- **Verzeichnis.** `~` ist der Benutzerordner (auch der Rückfall von `defaultCwd`), sonst nur Laufwerks- oder UNC-Pfade. `fs.stat` mit 2 s Grenze: Ein hängendes Netzlaufwerk soll den Hauptthread nicht in `CreateProcess` blockieren, es zählt als fehlend. Wie #113 startet die Session trotzdem, im Benutzerordner, mit `cwd_missing` ohne `distro`.
- **Umgebung.** Der Core läuft mit `ELECTRON_RUN_AS_NODE=1`. Erbte die Shell das, startete jedes Electron-Programm in ihr (VS Code `code`, Slack) als Node. Die Variable fällt weg; `launch.env` ersetzt Variablen ohne Rücksicht auf die Schreibweise, damit `Path` und `PATH` nicht nebeneinander stehen.
- **Ende des Core.** `registry.dispose()` gibt die PTYs frei, das beendet die Shells; `WindowsBackend.dispose()` beendet verbliebene und wartet auf die Schlange. Die Zustände bleiben gespeichert wie bei jedem Abbau, der nächste Core setzt `Interrupted`. Gemessen: Auch ein hart beendeter Elternprozess nimmt `cmd.exe` binnen 0,5 s mit.
- **Schließen-Dialog.** „Oberfläche schließen, Sessions behalten“ lässt den Core laufen, Windows-Shells laufen also weiter. Der Dialog sagt zusätzlich, dass sie nur so lange laufen wie der Core. Die Zahl kommt als optionales `windowsSessions` im Brücken-Event; ohne Windows-Shell bleibt das Event wie bisher.
- **Prüfmodus.** `--smoke-test` startet `cmd.exe /d /c exit 23` als Windows-Session und erwartet `Exited` mit Code 23. Es ist der einzige Test, der node-pty mit der mitgelieferten ConPTY aus dem Paket (asar-unpacked) prüft, und er braucht kein WSL, läuft also auch in der CI.
- **Rohpuffer im Pane.** Die View kürzte jeden Snapshot um Leerzeilen am Ende (`trimTrailingBlankLines`), weil ein tmux-Snapshot alle Zeilen des Panes listet. Beim Rohpuffer sind diese Zeilenumbrüche die Cursorbewegung der Shell: Nach `session.restart` stand die erste Ausgabe von `cmd` hinter der Trennzeile statt darunter (Szene 39). Für Windows-Sessions schreibt die View den Snapshot jetzt unverändert; WSL bleibt, wie es ist.
- **Renderer.** Logik in reinen Funktionen (`persistenceLimit`, `new-session.ts`, `newProjectFields`, `quitWindowsNote`, `countActiveWindows`); die `.tsx` zeigen nur an. `NameDialog` bekommt Auswahlfelder und Hinweise je Feld.
- **Ein PR.** Core und Desktop zusammen, weil V1-15 erst mit der sichtbaren Grenze erfüllt ist und die Abnahmeprüfung Nachweise unter einem offenen Kriterium ablehnt.

## Messung

- Backend-Tests mit echtem `cmd.exe` (18 in `backend/windows/backend.test.ts`, 2 in `bin/run-core-windows.test.ts`): rund 2 s zusammen.
- Lasttest und WSL-Tests: siehe PR.

## Risiken

- `PATH`-Suche findet eine Shell, die nicht startet (beschädigte Installation): node-pty scheitert, die Session wird `Interrupted` mit dem allgemeinen Text.
- Eine Shell, die `ClosePseudoConsole` ignoriert, endet nach 2,5 s über die PID (Schlange, ADR 0008).
- Ohne Verzeichnisprüfung beim Wiederanbinden gibt es nichts zu prüfen: Windows-Sessions werden nie angebunden.
