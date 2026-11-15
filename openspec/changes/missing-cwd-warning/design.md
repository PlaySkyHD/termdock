# Design

## Kontext

`WslBackend.start` ruft `wsl.exe -d <distro> --cd <cwd> --exec tmux … new-session …` in einer PTY auf. Vorher fragt es mit einem `wsl.exe`-Aufruf ohne PTY den Zustand der tmux-Session ab (`has-session ; display-message`). Gemessen mit WSL 2 und Ubuntu 26.04: Fehlt `cwd`, schreibt wsl.exe in der PTY `<3>WSL (…) ERROR: CreateProcessCommon:…: chdir(/srv/…) failed 2` und startet tmux trotzdem, die Shell läuft in `/` (`pwd` → `/`, auch wenn der tmux-Server schon läuft, denn `new-session` übernimmt das Verzeichnis des Clients). Ohne PTY bricht derselbe Aufruf dagegen mit `Wsl/ERROR_PATH_NOT_FOUND` (Exit 127) ab. tmux überzeichnet die Meldung sofort, der Nutzer sieht nichts.

## Entscheidungen

### Prüfung im WSL-Backend, parallel zum Statusaufruf

`start` ruft `Promise.all([status, cwdWarnings])` auf. `cwdWarnings` führt `wsl.exe -d <distro> --cd ~ --exec test -d <cwd>` aus (`cwdCheckArgs`, Argument-Array; zwei Argumente, so liest `test` den Pfad immer als Operand; GNU `test` kennt hier kein `--`). Geprüft werden nur absolute Pfade bis 512 Zeichen ohne NUL (`checksCwd`); `~`, `~/…`, relative und Windows-Pfade überlässt das Backend wsl.exe. Ergebnis (`parseCwdCheck`): Exit 0 = vorhanden, Exit 1 ohne Ausgabe = fehlt (`runWsl` setzt bei leerem stderr Nodes `Command failed: …` ein, das zählt als ohne Ausgabe), alles andere = unbekannt. Unbekannt, Zeitüberschreitung (eigener Timeout `cwdCheckTimeoutMs`, Standard 5 s) oder ein Wurf ergeben keine Warnung. Tritt `start` einer noch lebenden tmux-Session bei (`new-session -A`), gilt ihr Verzeichnis, also keine Warnung; `attach` prüft nicht.

Messung (15 Starts je Pfad, Median, isolierter Socket): `/tmp` (geprüft) 211 ms, `~` (ungeprüft) 179 ms, fehlender Pfad 207 ms. Die Prüfung kostet also rund 30 ms, weil zwei `wsl.exe`-Aufrufe gleichzeitig laufen; nacheinander wären es rund 150 ms. Verworfen: die Prüfung in den Statusaufruf einbauen (bräuchte eine Shell oder `tmux run-shell` mit zusammengesetztem String) und nach dem Start prüfen (die PTY verliert Ausgabe, bevor die Registry sie bindet).

### Rückgabe über `PtyHandle.warnings`

`Backend.start` liefert weiter einen `PtyHandle`; neu ist das optionale `warnings` (`backend/types.ts`, ausdrücklich beauftragte Änderung des gemeinsamen Bausteins). So bleibt `start` ein Aufruf, und die Registry bekommt die Warnungen im selben Schritt wie die PTY, ohne Lücke zwischen Start und Binden. `WslPty` hat dafür ein Feld, `FakePty` ebenso; `FakeBackend.missingCwds` simuliert fehlende Verzeichnisse.

### Warnungen in der Registry

`launch` übernimmt `pty.warnings` (höchstens 8, kopiert) vor `Starting → Running` nach `info.warnings`, ein Wiederanbinden (Neustart mit lebender tmux-Session) hat keine. `setState` löscht `warnings` bei jedem Zustand außer `Running` und `Detached`. Das Repository speichert sie nicht (`toStored` lässt sie weg wie `writerViewId`): Nach einem Core-Neustart fehlt die Warnung, der Lauf ist dann aber auch nicht mehr der frisch gestartete. Create, Neustart und Autostart nutzen denselben Weg (`launch`).

### Vertrag (Protokoll 1.5)

`SessionWarning { code, path?, distro? }`, `SessionInfo.warnings?` und `session.stateChanged.warnings?` (1 bis 8 Einträge, sonst Feld weglassen). `code` ist ein String aus `a-z`, Ziffern und `_` (1 bis 64 Zeichen); bekannt ist `cwd_missing` (`SESSION_WARNING_CODES`). Unbekannte Codes passieren den Guard, damit ein Client die Session-Liste eines neueren Core nicht verwirft; Clients zeigen nur bekannte Codes. `path` nach den Regeln für Pfade (1 bis 512 Zeichen, kein NUL), `distro` nach den Regeln für Namen. Der Server hängt `warnings` an jedes `session.stateChanged`, dessen Session welche hat; ein Wechsel ohne heißt „keine (mehr)“. `session.created` kommt in `Starting` und hat deshalb keine.

### Desktop

Die Brücke reicht `warnings` mit `stateChanged` weiter, `connectStore` an `sessionStateChanged`, das sie ersetzt (wie `lastExitCode`). Geschlossene Hinweise merkt sich der Store je Fenster (`dismissedWarnings`), bis die Session wieder `Starting` wird oder verschwindet; ein Detach und Attach desselben Laufs bringt den Hinweis also nicht zurück. `warningTexts` (rein) baut den Text; das Pane zeigt ihn oben (`.pane-warning`, links neben dem Griff) mit „Hinweis schließen“. Der Knopf nimmt beim Drücken den Fokus nicht (`preventDefault`), danach geht der Fokus an das Terminal zurück. Das Schließen eines Tabs entfernt das Pane und damit den Hinweis.

### Screenshot-Szene

`screenshot-cwd.ts` am Ende des Szenarios: Session `API` mit `/srv/termdock-missing-<pid>`, prüft die Warnung in der Antwort des Core, den Text im Pane und `cwd=/` im Terminal (`70-cwd-missing-warning.png`), schließt den Hinweis und tippt weiter (`71-cwd-warning-dismissed.png`), dann eine Session in `/tmp` ohne Hinweis.

## Risiken

- Ein `wsl.exe`, das bei einem Fehler mit Exit 1 und ohne Ausgabe endet, ergäbe eine falsche Warnung. Gemessen enden Distro- und Dienstfehler mit anderen Codes oder mit Meldung.
- Ein langsamer Prüfaufruf verzögert den Start höchstens um `cwdCheckTimeoutMs`, wenn der Statusaufruf schneller ist.
