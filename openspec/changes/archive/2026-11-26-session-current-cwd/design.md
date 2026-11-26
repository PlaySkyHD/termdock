# Design

## Context

Siehe proposal.md („Why“). Der Core hält je laufender Session eine PTY, deren Ausgabe er an die Views verteilt (ADR 0003). WSL-Sessions sind tmux-Sessions auf dem Socket `termdock`; jeder Aufruf ohne PTY ist ein eigener `wsl.exe`-Prozess (gemessen rund 50 bis 150 ms). tmux ermittelt `#{pane_current_path}` bei jeder Abfrage neu aus `/proc/<pid>/cwd` des Vordergrundprozesses und kennt keinen Hook, der bei einem Verzeichniswechsel feuert. Die Terminal-Ausgabe darf nicht als Anweisung ausgewertet werden (`security.instructions.md`), also kommt OSC 7 aus der Ausgabe nicht in Frage.

## Goals / Non-Goals

**Goals:**

- Nach einem `cd` in einer angezeigten WSL-Session kennt der Core das neue Verzeichnis nach rund einer Sekunde und meldet es genau einmal.
- Keine Abfrage für Sessions ohne View, ohne PTY oder ohne Ausgabe; keine Timer oder Abfragen über das Ende der PTY hinaus.
- Der Wert erreicht einen Client nie in einer Form, die dessen Guard ablehnt (eine abgelehnte `SessionInfo` ließe `session.list` scheitern).

**Non-Goals:**

- Verzeichnis von Windows-Sessions im Core (#200 liest es im Renderer aus OSC 9;9).
- Verzeichnis einer Session ohne View aktuell halten: Sie behält den zuletzt bekannten Wert, bis wieder eine View anhängt.

## Decisions

### Abfrage nach Ausgabepausen statt tmux-Hook oder Dauer-Polling

Die Registry fragt `Backend.currentCwd` in drei Fällen: beim Anhängen einer View, beim Binden einer PTY, wenn schon Views da sind (Start, Neustart, Wiederanbinden), und 300 ms nach der letzten Ausgabe der PTY (`CWD_QUIET_MS`). Ein `cd` erzeugt immer Ausgabe (Echo der Eingabe, neuer Prompt), danach ist es ruhig; die Pause ist der Zeitpunkt, an dem das Verzeichnis feststeht. Zwischen dem Beginn zweier Abfragen liegen mindestens 1 s (`CWD_MIN_INTERVAL_MS`), und je Session läuft höchstens eine; Ausgabe während einer Abfrage plant genau eine weitere danach. Tippen erzeugt also höchstens eine Abfrage je Sekunde, eine Session mit Dauerausgabe ohne Pause keine.

Verworfen:

- **Dauer-Polling** (z. B. alle 2 s je Session): kostet auch bei ruhigen Sessions einen `wsl.exe`-Prozess je Intervall und reagiert trotzdem langsamer.
- **tmux-Hook:** Es gibt keinen Hook für einen Verzeichniswechsel; `after-*`-Hooks feuern nur für tmux-Befehle, nicht für `cd` der Shell.
- **Steuermodus-Client mit Format-Abo** (`tmux -C`, `refresh-client -B`): tmux prüft das Abo selbst jede Sekunde und meldet Änderungen, aber jeder Steuermodus-Client ist ein weiterer dauerhafter `wsl.exe`-Prozess je Distro, erscheint in `list-clients` (das Neuzeichnen nach dem Anhängen, #34, träfe ihn) und braucht einen eigenen Parser für den Steuermodus. Der Aufwand lohnt erst, wenn Messungen zeigen, dass die Abfragen stören.
- **Shell-Integration (OSC 7, `PROMPT_COMMAND`):** wertet Terminal-Ausgabe aus oder ändert die Shell des Nutzers.

### Logik in einer eigenen Klasse `CwdProbe`

`session/cwd-probe.ts` kapselt Pause, Mindestabstand, „eine Abfrage zur Zeit“ und Abbau für eine Session; spätere Ausgabe verschiebt eine mit `poke()` geplante Abfrage nicht, sonst bekäme eine View an einer Session mit Dauerausgabe nie ein Verzeichnis; Abfrage, Ergebnis, Uhr und Timer kommen von außen, damit die Logik ohne Backend und mit künstlicher Zeit testbar ist. Die Registry legt je gebundener PTY eine an (nur wenn das Backend `currentCwd` hat), gibt ihr `activity()` für Ausgabe außerhalb eines Neuzeichnens, solange Views da sind, `poke()` beim Anhängen und `idle()`, wenn die letzte View geht. `releasePty` (Ende, Wiederanbinden, `dispose`) beendet die Probe; ein danach eintreffendes Ergebnis wird verworfen. So gehören Timer und Abfrage zur PTY und können sie nicht überleben.

### Nur Änderungen melden, Wert bleibt bei Fehlern

Die Registry vergleicht das Ergebnis mit `SessionInfo.currentCwd` und meldet nur einen anderen Wert. Liefert das Backend nichts (Fehler, Zeitüberschreitung, leere oder ungültige Antwort), bleibt der bekannte Wert, damit ein kurzer WSL-Fehler kein Flackern im Panel erzeugt. Verlässt die Session `Running` und `Detached`, entfernt `setState` das Feld (wie `warnings`, #113) und meldet danach `session.cwdChanged` ohne `currentCwd`, wenn es einen Wert gab.

### WSL-Abfrage

`has-session -t =td-<id> ; display-message -p -t =td-<id>: '#{pane_current_path}'` über `wsl.exe -d <distro> --cd ~ --exec tmux -L <socket> …` (wie `paneStatusArgs`, `--cd ~` wie alle Aufrufe außer dem Start), Zeitlimit 5 s. Die Antwort zählt nur, wenn sie ohne den Zeilenumbruch am Ende mit `/` beginnt und `isValidCurrentCwd` aus `packages/protocol` besteht (1 bis 512 Zeichen, keine Steuerzeichen U+0000 bis U+001F und U+007F). Ein Pfad mit Zeilenumbruch kommt damit nie an. `currentCwd` lehnt nie ab: Jeder Fehler ergibt `undefined`.

### Protokoll: Name, Form und Empfänger

- `SessionInfo.currentCwd?: string` (Laufzeitzustand wie `writerViewId` und `warnings`, das Repository entfernt es beim Speichern) und Event `session.cwdChanged { sessionId, currentCwd? }`. Fehlt `currentCwd`, ist das Verzeichnis unbekannt, wie `writerViewId` in `view.writerChanged`. Der Name folgt `session.stateChanged` und `view.writerChanged`.
- Der Guard prüft `currentCwd` mit derselben Funktion, die der Core vor dem Senden nutzt (`isValidCurrentCwd`), damit beide Seiten dieselbe Grenze haben.
- Empfänger im Core: Verbindungen mit einer View der Session und Listenclients, wie `session.stateChanged`. Das Verzeichnis ist Zustand der Session, den die Sidebar und ein später angehängtes Pane brauchen.
- Empfänger im Desktop: alle Fenster (Brücken-Event `cwdChanged`), wie `stateChanged`. Jedes Fenster führt alle Sessions im `UiStore`; ein Fenster, das eine Session erst später anzeigt, hat den Wert dann schon. Das Event kommt höchstens einmal je Sekunde und Session, die Last ist gering.

### Renderer

`renderer/session-cwd.ts` enthält die reinen Funktionen `withCurrentCwd(session, cwd)` (setzt oder entfernt das Feld; für eine Session außerhalb von `Running`/`Detached` entfernt es immer, damit ein spät angewendetes Event keine beendete Session mit Verzeichnis zurücklässt) und `currentCwdOf(state, sessionId)`. `UiStore.sessionCwdChanged(sessionId, cwd)` nutzt sie, `sessionStateChanged` entfernt das Feld beim Verlassen von `Running`/`Detached`. `session-sync.ts` hält das Event wie `stateChanged`, solange die erste Liste aussteht. #202 liest `currentCwdOf(store.getState(), sessionId)`.

## Risks / Trade-offs

- [Ein `cd` ohne folgende Ausgabepause, etwa `cd /tmp && tail -f log`] → Das Verzeichnis folgt erst mit der nächsten Pause; bei Dauerausgabe gar nicht. Für das Panel genügt das, ein Programm mit Dauerausgabe ändert selten das Verzeichnis.
- [Viele angezeigte Sessions mit stoßweiser Ausgabe] → Höchstens ein `wsl.exe` je Session und Sekunde; bei vier Panes also höchstens vier je Sekunde. Der Lasttest (#134) zeigt Sessions ohne View und bleibt unberührt.
- [Session ohne View behält einen veralteten Wert] → Beim Anhängen fragt die Registry sofort neu.
- [`pane_current_path` ist das Verzeichnis des Vordergrundprozesses, nicht der Shell] → Startet die Shell ein Programm, das wechselt, zeigt der Explorer dessen Verzeichnis; nach dem Ende des Programms folgt die Shell mit der nächsten Pause.
- [Ein älterer Client 1.7] → Verwirft das unbekannte Event (ADR 0002) und nimmt `SessionInfo` mit dem Feld an.

## Migration Plan

Keine Datenmigration: Das Feld wird nicht gespeichert. ADR 0002 bekommt den Eintrag für 1.8, ADR 0003 die Methode `currentCwd` in der Backend-Schnittstelle.
