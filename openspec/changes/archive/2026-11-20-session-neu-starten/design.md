# Design

## Kontext

`SessionRegistry.restart(sessionId)` gibt es seit Phase 1: `Exited | Interrupted → Starting`, dann `launch` mit `reuseExisting: true` (eine noch lebende tmux-Session wird angebunden, keine zweite gestartet) und `clearOutput: true` (Rohdaten-Puffer und Terminal-Modi werden erst geleert, wenn die neue PTY angebunden ist). Aufrufer ist bisher nur der Autostart (`session/autostart.ts`). Der Verlauf auf der Platte hängt an der Session-ID und läuft beim Neustart einfach weiter.

## Entscheidungen

### Protokoll 1.6: `session.restart`

`session.restart { sessionId }` → `{ session: SessionInfo }`, wie `session.create`. Die Zustandswechsel (`Starting`, `Running`/`Detached` oder `Interrupted`) kommen als `session.stateChanged` an jede Verbindung mit Views der Session und an alle Listen-Clients, wie bei jedem anderen Lifecycle-Wechsel; ein eigenes Event braucht es nicht. Anfrage und Antwort tragen keine Nutzdaten, unbekannte Felder sind `bad_request` (Regel neuer Anfragen seit 1.3). Neue Methode → Nebenversion 1.6; ein älterer Core antwortet mit `bad_request` (unbekannte Methode), ältere Clients bleiben verbunden.

### Fehler

- Unbekannte ID: `not_found` (`registry.entry`).
- Zustand nicht `Exited`/`Interrupted`: `invalid_state` aus `transition` (`Running → Starting` ist nicht erlaubt); läuft gerade ein anderer Lifecycle-Aufruf (`busy`), `invalid_state` aus `assertIdle`.
- Start scheitert: `backend_unavailable`, die Session ist `Interrupted`, der alte Puffer bleibt für den Snapshot (unverändert).

### Kein doppelter Start

`restart` läuft bis zum ersten `await` synchron: `assertIdle`, `setState(Starting)` und `entry.busy = "start"` in `launch`. Eine zweite Anfrage, auch eine, die im selben Tick ankommt, findet `busy` gesetzt und den Zustand `Starting` und scheitert mit `invalid_state`, bevor sie das Backend fragt. Der IPC-Server wartet vor jedem Dispatch auf `ready`, ruft die Registry danach aber ohne weiteres `await` auf. Ein Test schickt zwei Anfragen ohne zu warten und prüft genau einen Backend-Start.

### Keine verwaisten tmux-Sessions oder PTYs

Unverändert aus `launch`: Besteht die tmux-Session einer `Interrupted`-Session noch, wird sie angebunden. Wird der Core während des Neustarts beendet, gibt `bindFreshPty` die PTY frei und die Session bleibt für den nächsten Abgleich. Archivieren und Löschen während des Neustarts sind `invalid_state` (`busy`).

### Trennzeile

Nach dem Anbinden der neuen PTY und dem Leeren des Puffers schreibt die Registry `\r\n--- Neu gestartet <ISO-Zeitpunkt> ---\r\n` als erste Ausgabe des neuen Laufs, über denselben Weg wie PTY-Ausgabe (`emitOutput`): Puffer, Terminal-Modi, `outputSeq`, `onOutput`. Damit landet sie im Verlauf (der Recorder speichert jede Ausgabe ohne `fromRedraw`, wenn Logging an ist) und bei angehängten Views (`session.output`); Verlaufssuche findet die Grenze zwischen zwei Läufen. Der Zeitpunkt kommt aus `now()` (testbar), UTC wie `updatedAt`. Reiner Text ohne Escape-Sequenzen. Bei WSL zeigt das Pane den Snapshot aus `tmux capture-pane`, die Trennzeile steht dort also nicht; sie gehört zum Verlauf. Auch der Autostart schreibt sie, weil er denselben Weg nutzt: Dort ist die Grenze genauso nützlich.

### Desktop

- Bridge: `restartSession { sessionId }` → `session.restart`, Ergebnis `null`; der Store lernt den Zustand aus den Events.
- `paneContent` liefert für den Platzhalter zusätzlich `restartable` (`Exited` oder `Interrupted`). `PaneView` zeigt dann den Knopf „Neu starten“ (`data-action="restart-session"`), sperrt ihn während der Anfrage und zeigt eine Ablehnung im Platzhalter (`data-restart-error`). Wird die Session `Running` oder `Detached`, hängt sich das Pane an wie nach jedem Start; der Platzhalter verschwindet.
- `sessionMenu` bekommt den Eintrag `restart` („Neu starten“) vor „Archivieren …“, nur für `Exited`/`Interrupted`. Ein Fehler geht wie beim Verschieben in die Statusleiste (`onNotice`).
- Gemeinsame Regel `canRestart(state)` in `session-display.ts`, damit Knopf und Menü dieselbe Bedingung nutzen.

### Screenshot-Szenen

In der Gruppe `restore` gibt es schon den Platzhalter der unterbrochenen Session „Crash“. Nach dem Schließen ihres Panes öffnet die Szene sie erneut aus der Sidebar (Platzhalter mit „Neu starten“), klickt den Knopf, wartet auf `Running`/`Detached`, ein angehängtes Pane und die Trennzeile in `history.search`, und nimmt `19a-session-restarted.png` auf. Dann beendet sie „Crash“ mit `session.kill` (`Exited`), öffnet das Kontextmenü der Zeile und nimmt `19b-sidebar-restart-menu.png` mit dem Eintrag als Sichtbarkeitsselektor auf, wählt ihn, wartet auf den Neustart und beendet die Session wieder, damit spätere Gruppen dieselbe Lage vorfinden. Präfix `19` gehört schon zu `screenshot-restore.ts`; Buchstaben trennen Szenen innerhalb der Gruppe (`scene-prefixes.test.ts`). Freie Zehnerblöcke gibt es nicht mehr.

### Bestehende Prüfung der Gruppe `restore` stabilisiert

Die Prüfung nach „Pane schließen“ (`the closed pane is still in the saved layout`) scheiterte auch auf `main` (20e9e0d) zweimal hintereinander: Das zweite Fenster liegt unter dem ersten, Chromium drosselt verdeckte Fenster (keine Frames, Timer verzögert), und der Bericht des Renderers (50 ms Verzögerung in `layout-sync.ts`) kam nach dem einmaligen `flushLayout`. Die Szene holt das Fenster jetzt nach vorn (`moveTop`, `focus`, `invalidate`) und liest das Layout bis zu 10 s lang erneut, bis das Pane fehlt; dasselbe Nach-vorn-Holen vor den neuen Aufnahmen verhindert ein veraltetes Bild (19b zeigte einmal den Stand von 19a).

## Risiken

- Die Trennzeile ändert die Ausgabe nach jedem Autostart-Neustart. Tests, die die Ausgabe genau vergleichen, müssen sie erwarten.
- Eine View, die nach dem Ende ihrer Session offen blieb, sieht die Trennzeile und danach den neuen Lauf; das ist gewollt.
