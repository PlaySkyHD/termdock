# Design

## Kontext

#67 ordnet Tabs und Panes mit Zeigerereignissen innerhalb eines Fensters (`renderer/drag/`, `layout-moves.ts`). Ein verschobenes Pane behält dort seine View, weil das Fenster alle Panes in einer flachen Liste zeichnet. Zwischen zwei Fenstern geht das nicht: Jedes Fenster hat seinen eigenen Renderer, und eine View gehört dem Fenster, das sie angehängt hat (ADR 0006). Das Zielfenster braucht eine eigene View mit eigenem Snapshot.

Der Core gibt einer View das Schreibrecht nur, wenn sie die erste angehängte View der Session ist; trennt sich der Schreiber, bekommt niemand es automatisch (ADR 0005). `session.claimWriter` überträgt es atomar.

## Entscheidungen

### Der Zeiger bleibt im Quellfenster

Chromium gibt einem Fenster, in dem die Maustaste gedrückt wurde, die Mausereignisse auch außerhalb seiner Fläche (Capture), also auch `pointermove` und `pointerup` mit Koordinaten außerhalb des Viewports. Der `DragController` des Quellfensters läuft deshalb weiter; die Zustandsmaschine (`drag-model.ts`) bekommt bei jeder Bewegung und beim Loslassen das Flag `outside` (Zeiger außerhalb des Viewports). Darf die Nutzlast das Fenster verlassen (`leaves`: Tab oder Pane), wird ein Loslassen außerhalb zum Effekt `outside` statt `cancel`. Esc und Fokusverlust brechen wie bisher ab.

Native HTML5-Ziehen scheidet weiter aus (ADR 0006: keine Abbruchtaste, nicht mit `sendInputEvent` prüfbar). `screen.getCursorScreenPoint()` im Main wäre unabhängig vom Renderer, sieht aber die Ereignisse von `sendInputEvent` nicht; die Szenen könnten den Zug dann nicht prüfen. Der Main rechnet stattdessen die Client-Koordinaten des Quellfensters mit dessen `getContentBounds()` in Bildschirmkoordinaten um (Zoom 1, wie überall in der App).

### Der Main koordiniert

`main/window-transfer.ts` (`WindowTransfers`, ohne Electron) hält Zug und Übergabe; Electron steckt hinter einer schmalen Schnittstelle (`TransferHost`: Fenster am Punkt, Koordinaten, Fenster öffnen, verschieben, schließen, Event senden, Schreiber prüfen und übertragen, Zeitgeber).

- **Überfahren:** Das Quellfenster meldet `transferHover { item, x, y }`, solange der Zeiger außerhalb ist. Der Main sucht das oberste andere Fenster unter dem Punkt (Reihenfolge des letzten Fokus, weil Electron keine Z-Ordnung liefert) und sendet ihm `transferHover { hover: { item, x, y } }` in dessen Client-Koordinaten; das vorher überfahrene Fenster bekommt `transferHover {}`. `transferHoverEnd` (Zeiger zurück, Esc, Ablegen) räumt auf.
- **Ablegen:** `transferDrop { item, x, y, whole }`. Unter dem Punkt liegt
  - ein anderes Fenster: es bekommt `transferIn { transferId, item, at }`;
  - das Quellfenster selbst (Rahmen, Titelleiste): nichts geschieht;
  - kein Fenster und `whole` (das Element ist der ganze Inhalt): das Quellfenster wandert an den Punkt, ohne Übergabe;
  - kein Fenster: der Main öffnet ein neues Fenster an der Mausposition und sendet `transferIn` ohne `at` (Ende der Tab-Leiste), sobald dessen Renderer sein Layout geholt hat (`windowLayout`).
- **Übergabe:** Das Ziel setzt das Element mit neuen IDs ein (`applyIncoming`), seine Panes hängen wie jedes Pane an. Sobald jedes eingesetzte Pane angehängt ist oder einen Platzhalter zeigt, meldet es `transferAttached { transferId, views }` (Quell-Pane → neue View) oder ohne `views` eine Ablehnung. Der Main überträgt dann für jede alte View, die gerade schreibt, das Schreibrecht an die neue View derselben Quell-Pane (`session.claimWriter`), und erst danach schließt er das Quellfenster (`whole`) oder sendet ihm `transferOut { source }`, worauf es das Element entfernt und seine Views löst.
- **Fehler:** Lehnt das Ziel ab, fehlt einer schreibenden View ihr Nachfolger, scheitert ein `claimWriter`, schließt das Zielfenster oder vergehen 75 s (über dem Attach-Zeitlimit von 60 s), bekommt das Ziel `transferCancel`, entfernt die eingesetzten Panes (lesende Views), und das Quellfenster behält alles. Schon übertragene Schreibrechte holt der Main vor dem Abbruch an die alte View zurück. Ein neu geöffnetes Fenster ohne Inhalt schließt er wieder.

Der Main prüft den Schreiber selbst: Die Brücke merkt sich je Session den Schreiber aus `view.writerChanged` und der Attach-Antwort. Der Renderer meldet nur, welche View zu welchem Pane gehört; der Main nimmt nur Views, die dem Quellfenster gehören.

### Reihenfolge im Core

Für eine schreibende View `v1` in A und das Ziel B: `session.attach` (B, liest, weil `v1` noch angehängt ist) → `session.claimWriter(v2)` (Schreiber wechselt atomar von `v1` auf `v2`) → `session.detach(v1)` (kein Schreiberwechsel, `v1` schreibt nicht mehr). Für eine lesende View entfällt `claimWriter`. Zu keinem Zeitpunkt gibt es zwei Schreiber oder keinen. Eine neue Methode `session.move` oder ein Feld `claim` an `session.attach` wäre ein Protokollwechsel ohne Gewinn: Die bestehenden Methoden sind atomar genug. Ein Core-Test (`registry.test.ts`) hält die Reihenfolge fest.

Die Rolle der neuen View folgt `view.writerChanged`; sie sendet erst als Schreiber Größe (`fitAsWriter`), die alte View wird Leser und sendet nichts mehr. Bevor `transferOut` ankommt, sieht der Nutzer das Element kurz in beiden Fenstern, eines davon lesend.

### Renderer

- `window-transfer.ts` (rein): `transferItem` (Element aus Fenster und Views), `applyIncoming` (Element mit neuen IDs auf ein Ziel von `layout-drop.ts`, über `applyMove` auf ein vorübergehend angehängtes Tab; Layout-Vorschläge und Tausch sind keine Ziele), `withoutIncoming` (Rücknahme), `takeOut` (Entfernen im Quellfenster) und `settleIncoming` (wartet auf jedes eingesetzte Pane, Ergebnis für `transferAttached`).
- `DragProvider` bekommt einen äußeren Modus: `transferHover` zeigt im Ziel denselben Zustand `dragging` mit Nutzlast `incoming` (gültige Ziele gestrichelt, Ziel unter dem Zeiger voll, Schatten). `transferIn` sucht das Ziel am Punkt mit derselben Trefferfunktion. Ein laufender eigener Zug hat Vorrang.
- `TerminalController` meldet das Ende von `open` (`onAttached` mit View oder ohne); `PaneView` meldet einen Platzhalter sofort.

### Layout

Beide Fenster melden ihr Layout wie bei jeder Änderung; das Ziel nutzt neue IDs, also bleiben die IDs im Dokument eindeutig, auch während das Element kurz in beiden Fenstern steht. Ein geschlossenes Quellfenster verlässt das Layout wie jedes vom Benutzer geschlossene Fenster, das nicht das letzte ist (#29). Nach dem Neustart steht das Element im Zielfenster.

## Risiken

- Bewegt der Nutzer die Maus über ein Fenster eines anderen Programms, das über dem TermDock-Fenster liegt, landet der Zug trotzdem im TermDock-Fenster darunter (keine Z-Ordnung über Programme hinweg). Hinnehmbar.
- Monitore mit verschiedener Skalierung: Die Umrechnung über `getContentBounds()` gilt in DIP; an der Grenze zweier Monitore kann der Punkt um wenige Pixel abweichen.
- Ablegen auf der Mitte eines Panes ersetzt dessen View; bricht die Übergabe danach ab, bleibt die ersetzte View weg (wie bei #67 ist sie gelöst, ihre Session läuft weiter).

## Dependencies

Keine neuen.
