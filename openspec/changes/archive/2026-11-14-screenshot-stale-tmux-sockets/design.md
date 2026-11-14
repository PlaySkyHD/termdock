# Design

## Context

Seit #37 hat jeder Screenshot-Lauf einen eigenen Socket. `finish()` beendet dessen Sessions über `core.shutdown { stopSessions: true }`; nach einem Abbruch geschieht das nie. Alte Electron-Profile räumt der nächste Lauf bereits auf (`staleProfileDirs`).

## Goals / Non-Goals

**Goals:** Server abgebrochener Läufe beim nächsten Lauf beenden, ohne `termdock`, `termdock-test` oder laufende Läufe zu berühren.

**Non-Goals:** Aufräumen außerhalb des Screenshot-Modus, andere Socket-Namen, Änderungen an Core oder Szenen.

## Decisions

- **Auswahl rein.** `staleSockets(names, ownPid, isAlive)` filtert mit der Regex `^termdock-test-(\d+)-[0-9a-f]+$` und nimmt nur Sockets, deren Prozess nicht läuft und nicht der eigene ist. `isAlive` ist dieselbe Funktion wie bei `staleProfileDirs` (`process.kill(pid, 0)`, `EPERM` zählt als lebend).
- **Seam.** `cleanStaleSockets(ownPid, deps)` kennt nur `listSockets`, `killServer`, `isAlive`, `log`; es lehnt nie ab. Der Name wird unmittelbar vor `kill-server` erneut gegen die Regex geprüft.
- **WSL-Teil ohne Shell-String.** Auflisten: `wsl.exe --cd ~ --exec find /tmp -maxdepth 2 -path '/tmp/tmux-*/termdock-test-*' -type s -printf '%p\n'` (das Verzeichnis `/tmp/tmux-<uid>` wird ohne Kenntnis der uid gefunden; `find` endet bei unlesbaren Ordnern mit Code 1 und listet trotzdem, Code 1 gilt als Erfolg). Der volle Pfad muss strikt `^/tmp/tmux-\d+/termdock-test-\d+-[0-9a-f]+$` entsprechen. Beenden: `wsl.exe --cd ~ --exec tmux -L <name> kill-server`; meldet tmux `no server running` oder `error connecting`, gilt der Server als beendet. Danach (auch nach erfolgreichem `kill-server`, tmux lässt die Datei liegen) entfernt `rm -f -- <pfad>` die Socket-Datei, damit spätere Läufe sie nicht erneut anfassen. `execFile` ist injizierbar (Tests prüfen die Argument-Arrays).
- **Distro.** Kein `-d`: `wsl.exe` nimmt die Standard-Distro. Der WSL-Backend des Cores bestimmt die Distro für Sessions ohne `distro` ebenfalls als WSL-Standard (`resolveDistro`), die Sessions des Laufs liegen also in derselben Distro; ein fest kodiertes `Ubuntu` würde bei anderer Standard-Distro ins Leere laufen.
- **Zeitpunkt.** Der Aufräumvorgang startet mit den alten Profilen am Anfang des Laufs ohne zu blockieren; `finish()` und der Fehlerpfad (Core nicht erreichbar) warten vor dem Beenden darauf, höchstens 30 s (`settleWithin`).

## Risks / Trade-offs

- Wurde die PID eines toten Laufs von einem anderen Prozess wiederverwendet, bleibt der Server bis zum nächsten Lauf bestehen. Akzeptiert (wie bei den Profilen).
- Ist WSL nicht erreichbar, loggt der Lauf einen Fehler und läuft weiter.
