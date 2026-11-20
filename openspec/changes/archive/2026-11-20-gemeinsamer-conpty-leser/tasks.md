# Tasks

## 1. Leser und Versionsprüfung

- [x] 1.1 Test und Umsetzung: installierte node-pty-Version ist 1.1.0, eine andere Version meldet eine Zeile und lässt `ConoutConnection` unverändert, ohne laufenden Worker wirft das Anlegen einer Verbindung (`backend/wsl/conout-reader.test.ts`, „node-pty version“)
- [x] 1.2 Test und Umsetzung: ein Worker, der nicht startet, lässt `ready()` scheitern, der nächste startet (`backend/wsl/conout-reader.test.ts`, „ConoutReader worker“)

## 2. PTYs über den Leser

- [x] 2.1 Test und Umsetzung: `spawnConpty` wartet auf den Worker; 20 PTYs mit `cmd.exe` teilen einen Worker und erhöhen den RSS um weniger als 60 MiB, ohne Leser rund 230 MiB (`backend/wsl/conout-reader.test.ts`, „20 PTYs share one worker thread“)
- [x] 2.2 Test und Umsetzung: `kill()` unter voller Ausgabe kehrt in unter 1 s zurück, jede PTY endet genau einmal, der Worker schließt alle Pipes (`backend/wsl/conout-reader.test.ts`, „kill() does not block“)
- [x] 2.3 Test und Umsetzung: Absturz des Workers beendet jede PTY genau einmal samt Prozess, die nächste PTY bekommt einen neuen Worker (`backend/wsl/conout-reader.test.ts`, „closes every PTY once when the worker crashes“)
- [x] 2.4 WSL-Integrationstest mit `wslTestSocket()`: nach dem Absturz je Session genau ein neuer tmux-Client, Eingabe kommt an, `Running` und Schreiber bleiben, gleich viele `wsl.exe` (`conout-reader.wsl.test.ts`)

## 3. Dokumentation und Messung

- [x] 3.1 ADR 0008 und Nachtrag in ADR 0003; geprüft durch `npm run format:check` und den Review
- [x] 3.2 Lasttest mit 50 Sessions unter Node und Electron, Werte im PR; geprüft durch den Lauf selbst (Exit-Code 0 nur bei eingehaltenen Grenzwerten)
- [x] 3.3 Installer gebaut, `--smoke-test` der entpackten App und eine PTY mit dem Leser aus dem Paket; geprüft durch den Exit-Code des Prüfmodus und den Paketinhalt (`@electron/asar list`)
