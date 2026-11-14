# Design

## Context

`SessionRegistry.attachView` fragt `backend.snapshot` ab (WSL: `capture-pane` + Cursor in einem `wsl.exe`-Aufruf), sammelt die PTY-Ausgabe dieser Zeit (`inFlight`) und hängt sie an den Snapshot. Erst danach registriert sie die View; Ausgabeereignisse nennen die View ab da (`viewIds`). `CoreServer.attach` hält Events der Verbindung bis hinter die Antwort zurück. Der Desktop-Main zählt `session.output` je Session selbst und nimmt als Marke die letzte Nummer, die er bis zur Verarbeitung der Antwort gesehen hat.

Die PTY-Ausgabe ist das, was der tmux-Client zeichnet, nach der ConPTY (1.23, mitgeliefert in node-pty 1.1.0). Sie läuft dem Zustand des tmux-Servers hinterher. `capture-pane` bildet dagegen den Server zum Zeitpunkt der Abfrage ab.

### Messung (WSL-Integrationstest, vor der Änderung)

Eine Schleife hängt alle 20 ms eine Zahl an (`printf "$i "`, nur Shell-Builtins), drei weitere Clients hängen bei 130, 180 und 230 an. Snapshot plus Live-Ausgabe jeder View laufen durch einen Terminal-Emulator und werden mit `capture-pane` verglichen. Ergebnis in 4 von 4 Läufen rot, z. B. Snapshot bis `145`, Cursor dahinter, angehängte `inFlight`-Ausgabe `142 143 144 145`: Die View zeigt `140 141 142 143 144 145 142 143 144 145 146 …`.

Zwei Beobachtungen aus dem Rohstrom:

- Die ConPTY gibt Text ohne Cursor-Positionierung weiter, wenn der Cursor schon dort steht. Doppelte Ausgabe ist deshalb nicht idempotent, sie verschiebt alles Folgende.
- tmux zeichnet den Bildschirm manchmal von selbst neu (beim Wechsel des Vordergrundprogramms; etwa eine Sekunde nach dem Ende der Ausgabe, mit erneuter Terminal-Initialisierung). Das verdeckt den Fehler oft und erklärt, warum er nur gelegentlich sichtbar ist. Der Test vergleicht deshalb bis zum Ende der Schleife und nutzt nur Builtins.

Eine Probe mit node-pty, ConPTY und `tmux refresh-client -t <tty>` zeigt: Das Neuzeichnen kommt vollständig durch die ConPTY (`ESC[H`, jede Zeile mit `ESC[K`, zuletzt die Cursorposition).

## Goals / Non-Goals

**Goals:**

- Nach dem Anhängen zeigt eine View genau den Bildschirm von tmux: nichts doppelt, nichts fehlt.
- Eine exakte Grenze im Ausgabestrom des Core, die auch der Desktop-Main nutzt.

**Non-Goals:**

- Snapshot ohne Zwischenzustand: Bis das Neuzeichnen ankommt (etwa 100–200 ms), kann die View kurz doppelte oder fehlende Zeichen zeigen.
- Terminal-Emulator im Core, Windows-Rohpuffer, Wiederverbinden des Desktop.

## Decisions

### 1. Nummern im Core statt `inFlight`

Die Registry zählt je Session jede PTY-Ausgabe (ab 1, über PTY-Wechsel hinweg) und meldet die Nummer im `OutputEvent`. `attachView` liefert `outputSeq`: die Nummer der letzten Ausgabe beim Registrieren der View. Registrieren und Lesen der Nummer geschehen im selben synchronen Schritt, deshalb ist die Grenze im Strom des Core exakt: Jede Ausgabe mit höherer Nummer nennt die View, jede andere nicht. `inFlight` entfällt; der Snapshot des Backends bleibt unverändert, samt `cursor`.

Der Server gibt `seq` in `session.output` und `outputSeq` im Attach-Ergebnis weiter. Teilt er Ausgabe über der Nutzdatengrenze, tragen alle Teile dieselbe Nummer; die Grenze liegt immer zwischen zwei PTY-Ausgaben, also reicht das.

Allein reicht das nicht (gemessen: nur Nummern ohne `inFlight` und ohne Neuzeichnen bleibt der Test in 3 von 3 Läufen rot, diesmal mit Lücken wie `146 149`): Der Strom selbst hinkt `capture-pane` hinterher. Ausgabe, die der Server vor der Abfrage verarbeitet hat, die aber erst nach dem Registrieren beim Core ankommt, steht im Snapshot und kommt live noch einmal. Ausgabe nach der Abfrage, die vor dem Registrieren ankommt, fehlt. Ohne einen Synchronisationspunkt im Strom gibt es keine exakte Grenze zu `capture-pane`.

### 2. Neuzeichnen als Synchronisationspunkt

Nach dem Registrieren ruft die Registry `backend.redraw` auf (neue optionale Methode der Backend-Schnittstelle), nur wenn der Snapshot vom Backend stammt. Das WSL-Backend ermittelt die Clients der Session (`list-clients -F '#{client_tty}'`) und ruft je Client `refresh-client -t <tty>` auf. tmux schreibt das Neuzeichnen in den Client-Strom hinter alles, was es vorher geschrieben hat; es kommt also nach jeder hinterherhinkenden Ausgabe bei der View an und überschreibt den ganzen Bildschirm samt Cursor. Was danach kommt, ist Ausgabe auf dem richtigen Bildschirm.

- Das Neuzeichnen wird nicht abgewartet: Die Antwort mit dem Snapshot geht sofort raus, Fehler werden verworfen (das Anhängen gelingt mit dem Snapshot; ADR 0003: ein fehlender Bildschirm darf das Anhängen nicht scheitern lassen).
- Alle Views der Session sehen das Neuzeichnen. Es zeichnet denselben Inhalt, sichtbar ist höchstens ein kurzes Ausblenden des Cursors.
- Der Rohdaten-Puffer (Windows, Fallback) braucht kein Neuzeichnen: Er wird im selben synchronen Schritt kopiert, in dem die View registriert wird.
- Zwei `wsl.exe`-Aufrufe, weil tmux `refresh-client` nur mit einem Client-Namen adressiert (eine Session als Ziel ergibt „can't find client“, gemessen). Der Client-Name kommt von tmux und muss `/dev/` plus `[A-Za-z0-9/_-]` sein, sonst wird er verworfen.

Verworfene Alternativen:

- **Nur Nummern, `inFlight` behalten oder weglassen:** wie oben gezeigt, bleibt das Rennen zwischen `capture-pane` und PTY-Strom.
- **Nur Neuzeichnen ohne Nummern:** Der Desktop-Main könnte die Grenze weiterhin nicht exakt bestimmen (Events für eine andere View derselben Session im selben Fenster, die der Core zurückhält und in einem späteren Lesevorgang ankommen).
- **Snapshot aus einem Terminal-Emulator im Core** (`@xterm/headless` je Session): exakt ohne Zwischenzustand, aber Laufzeit-Abhängigkeit, Speicher und CPU für jede Ausgabe jeder Session und eine Änderung der Snapshot-Entscheidung in ADR 0003. Für dieses Issue zu groß.
- **Größe kurz ändern (SIGWINCH):** zeichnet ebenfalls neu, stört aber das Programm in der Session.

### 3. Protokoll 1.1

`SessionAttachResult.outputSeq?` und `session.output { seq? }` sind optionale Felder, die Guards prüfen nicht negative ganze Zahlen. `PROTOCOL_VERSION` wird `1.1` (MINOR): Ein 1.0-Client ignoriert die Felder, ein 1.1-Client an einem 1.0-Core bekommt sie nicht.

### 4. Desktop-Main

`DesktopBridge` nimmt `seq` aus dem Event und `outputSeq` aus dem Attach-Ergebnis. Fehlen sie (1.0-Core), zählt sie wie bisher selbst und nimmt die zuletzt gezählte Nummer als Marke. Renderer (`terminal-controller.ts`) und Brückentypen bleiben unverändert: Sie vergleichen schon Nummern mit der Marke.

### 5. Test mit `@xterm/headless`

Der WSL-Integrationstest muss Snapshot plus Live-Ausgabe so auswerten, wie eine View sie darstellt; der Rohstrom enthält Cursor-Sprünge, Löschsequenzen und Umbrüche. `@xterm/headless` 6.0.0 ist dieselbe Emulation wie `@xterm/xterm` 6.0.0 im Desktop, ohne DOM, MIT-Lizenz, ohne weitere Abhängigkeiten. Sie wird nur devDependency von `packages/core` und nur im Test geladen; der Core zur Laufzeit bleibt ohne sie. Ein reiner Zählervergleich ohne Emulator wurde verworfen, weil Cursor-Positionierung und Neuzeichnen dort nicht auswertbar sind.

## Risks / Trade-offs

- Kurzer Zwischenzustand bis zum Neuzeichnen (siehe Non-Goals).
- Jedes Anhängen kostet zwei zusätzliche `wsl.exe`-Aufrufe im Hintergrund.
- Ein Nutzer-Client derselben Session (manuelles `tmux attach` auf dem Socket) wird ebenfalls neu gezeichnet; das ist harmlos.
- Läuft das Neuzeichnen, während die PTY wechselt (Wiederanbinden), zeichnet tmux den neuen Client ohnehin vollständig.
