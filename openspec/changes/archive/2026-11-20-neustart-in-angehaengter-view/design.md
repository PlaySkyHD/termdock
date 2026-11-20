# Design

## Kontext

`PaneView` (`PaneTree.tsx`) zeigt eine `TerminalView`, sobald die Session einmal anhängbar war, und behält sie, wenn die Session endet. Der Core behält beim Ende und beim Neustart (`SessionRegistry.restart`) alle Views und den Schreiber; ein Neustart schreibt die Trennzeile und danach die Ausgabe des neuen Laufs an dieselben Views. Die View braucht also keine neue Anbindung, nur einen Knopf.

## Entscheidungen

- **Modell rein in `restart-session.ts`.** `restartBar(session, role, status)` liefert `undefined`, einen Hinweis (`hint`) oder einen Knopf (`button`) samt Titel, Grund, Laufzustand und Fehlertext. Nur `canRestart(state)` und die Rolle der View entscheiden: `writer` → Knopf, `reader` → Hinweis, alles andere (`connecting`, `error`, `restarting`, `closed`) → nichts; bei `restarting`/`closed` liegt schon die Meldung des Core-Verlusts über dem Pane.
- **Die Leiste gehört zu `PaneView`, nicht zu `TerminalView`.** `PaneView` hält den `RestartStatus` schon für den Platzhalter; dieselbe Funktion `restartFromPlaceholder` steuert den Knopf in der Leiste. Die Rolle der View liest `PaneView` aus dem `onStatus`, das es ohnehin an das Fenster weiterreicht. `TerminalView` bleibt unverändert.
- **Lage und Eingabe.** Die Leiste liegt oben links im Pane, neben dem Griff, über dem Terminal (`z-index` über `.terminal-view`, unter der Meldung des Core-Verlusts). Sie nimmt keine Maus (`pointer-events: none`), nur der Knopf; Auswahl und Doppelklick („Eingabe übernehmen“ eines Lesers) gehen weiter ans Terminal. Der Knopf verhindert beim Drücken den Fokuswechsel (`preventDefault` auf `mousedown`, wie „Hinweis schließen“): Der Fokus bleibt in xterm, nach dem Neustart tippt der Benutzer sofort in den neuen Lauf. Die Leiste sendet selbst nichts an die View, eine lesende View sendet weiter weder Eingabe noch Resize (`TerminalController`).
- **Fehlertext zurücksetzen.** Die Meldung verschwindet, sobald die Session wieder lebt (`Running`, `Detached`) oder archiviert ist (`clearsRestartError`). Ein Rücksetzen bei jedem Zustandswechsel wäre ein Rennen: Ein gescheiterter Neustart läuft `Exited → Starting → Interrupted`, und das Event `Interrupted` kann im selben Render wie die Ablehnung ankommen; ein Effekt auf den Zustand würde die frische Meldung dann sofort löschen. `Starting`, `Exited` und `Interrupted` behalten sie daher. Die Leiste zeigt sie ohnehin nur bei `Exited`/`Interrupted`, und ein neuer Klick löscht sie.
- **Keine neue Dependency, kein Protokoll.**

## Risiken

- Die Leiste verdeckt die oberste Zeile der letzten Ausgabe. Das Pane zeigt dort die ältere Ausgabe, die letzte Zeile (etwa `[exited]`) bleibt unten sichtbar.
- Hatte der alte Lauf den Alternate Screen offen (tmux, das mit WSL starb), bleibt xterm darin; der neue Lauf zeichnet ihn neu. Die Modi des alten Laufs setzt der Core nur in seinem Puffer zurück, nicht in offenen Views.
