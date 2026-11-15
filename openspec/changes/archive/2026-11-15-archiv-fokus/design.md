# Design

## Kontext

`archive()` in `Sidebar.tsx` übergibt `confirm(...)` als „done“-Plan `SIDEBAR_FOCUS`. Der Effekt, der `pendingFocus` ausführt, sucht dessen Selektor und fokussiert ihn; deshalb landet der Fokus auf „+“, obwohl die Zeile im Archiv weiterbesteht. Beim Verschieben trägt der Plan ein `waitFor`, weil die Zeile erst mit dem Ereignis des Core in der neuen Gruppe erscheint.

## Entscheidungen

### `waitFor` kennt das Archiv

`FocusPlan.waitFor` ist eine Vereinigung aus `{ sessionId, workspaceId }` und `{ sessionId, archived: true }`. `focusReady` ist bereit, wenn die Session fehlt oder (je nach Variante) in der Gruppe beziehungsweise im Zustand `Archived` ist. Der Plan nach dem Archivieren ist `sessionFocus(id, { sessionId: id, archived: true })`. Ohne Warten fände der Effekt die Zeile noch in der alten Gruppe, und der Fokus ginge an eine Zeile, die gleich verschwindet.

### Das Archiv klappt auf

Das Archiv ist standardmäßig zugeklappt, die Zeile also nicht im DOM; der Effekt fiele auf „+“ zurück. Nach erfolgreichem `archiveSession` setzt die Aktion `archiveOpen` auf `true`. Das gilt für Menü, Tastatur und Ziehen, weil alle über `archive()` laufen. Der Nutzer kann es wieder zuklappen.

### Abbrechen und Fehler

Der „cancelled“-Plan bleibt die auslösende Zeile. Scheitert die Aktion, bleibt der Dialog offen und weder Fokus noch Archiv ändern sich.
