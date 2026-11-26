# Design

## Context

Siehe proposal.md („Why“). Der Renderer hält den Zustand eines Fensters im reinen `UiStore` (ADR 0006), Sessions mit `currentCwd` (#199). Windows-Shells melden ihr Verzeichnis nur im Renderer (`TerminalController.onCwd`, #200). Dateien liest der Main über `window.termdock.files` (ADR 0009); `list` liefert höchstens 5000 Einträge, Ordner zuerst. Das Layout prüft der Core mit den Guards aus `packages/protocol`, die unbekannte Schlüssel ablehnen.

## Goals / Non-Goals

**Goals:**

- Nach einem `cd` zeigt das Panel den neuen Ordner, ohne dass der Nutzer etwas tut; Tab- und Pane-Wechsel ebenso.
- Eine langsame Antwort für einen alten Ordner überschreibt nie den neuen.
- Die Regeln (Baum, Wahl der Session, Tasten, Breite, Texte) sind rein und getestet; `#203` baut darauf auf.

**Non-Goals:**

- Dateiaktionen (#203), Dateiwächter, Lösen von der Shell (#205).

## Decisions

### Ein Baum-Modell mit Ladetoken

`explorer-tree.ts` hält Wurzel, Ordnerzustände je Pfad (`loading` mit Token und den vorigen Einträgen, `loaded`, `error`), aufgeklappte Pfade und die Auswahl. Jede Ladung bekommt ein Token; `finishLoad` nimmt eine Antwort nur, wenn Backend und Distro passen und der Ordner noch genau mit diesem Token lädt. Ein neuer Baum für einen anderen Ordner (`treeFor(root, previous)`) zählt die Token weiter, also passt eine Antwort für den alten Ordner auch nach einem Wechsel hin und zurück nie. Beim Aktualisieren bleiben die alten Einträge sichtbar, bis die Antwort kommt (kein Flackern).

Für #203: `entryRow`, `selectEntry`, `replaceEntry(tree, parent, name, next?)` (ersetzen oder entfernen, aufgeklappte Ordner darunter und eine Auswahl darunter fallen weg) und `reloadFolder(tree, path)`.

Verworfen: Zustand in React (`useReducer`) mit der Antwort in der Closure. Eine Antwort müsste dann gegen den Zustand ihres Renders geprüft werden; mit dem Baum in einer Ref prüft `finishLoad` gegen den gezeigten.

### Welche Session

`explorerPaneId`: das aktive Pane, wenn es schreibt; sonst ein schreibendes Pane des aktiven Tabs (dort tippt der Nutzer); sonst das aktive Pane. Die Rolle kommt aus dem Status der View. `explorerTarget` liefert den Ort oder den Grund, warum es keinen gibt; der Schlüssel aus Session, Backend, Distro und Pfad bestimmt, wann das Panel neu lädt.

### Windows-Verzeichnis im Store

`relayCwd` hängt sich an jeden `TerminalController` und schreibt dessen Pfad mit `sessionCwdChanged` in den Store. Mehrere Views derselben Session melden denselben Pfad; der Store ändert sich nur bei einem anderen. So liest das Panel eine Quelle für beide Backends.

### Distro einer WSL-Session ohne Distro

Der Core meldet `session.created` im Zustand `Starting`, bevor das Backend die Standard-Distro festlegt; kein späteres Event trägt sie. Das Panel nimmt für eine WSL-Session ohne Distro deshalb die Standard-Distro von WSL aus `wsl.distros` (einmal je Fenster und Core-Generation gefragt). Eine Einstellung `defaultDistro` setzt der Core schon vor dem Event, sie steht also in der Session. Verworfen: den Core ändern (Event nach dem Festlegen), weil es den Vertrag von `session.created` (Zustand `Starting`, vor der Antwort) berührt; eine neue Sessionliste nach jedem Start, weil sie den Store für alle Sessions ersetzt.

### Sichtbarkeit und Breite im Layout (Protokoll 1.9)

Das Layout hat keine frei erweiterbaren Fensterdaten (`onlyKeys` lehnt Unbekanntes ab). Deshalb zwei optionale Felder in `LayoutWindow`: `explorerVisible` (fehlt = sichtbar) und `explorerWidth` (Pixel, fehlt = 280). Der Core speichert das Dokument unverändert; nur die Guards und die Versionsnummer ändern sich. Läuft nach einem Update noch ein Core 1.8, lehnt er die Felder mit `bad_request` ab; der Main (`LayoutCoordinator.write`) speichert dann ohne sie (`withoutExplorer`), damit Tabs und Panes nicht verloren gehen.

### Tastatur und Fokus

`Ctrl+Shift+E` (VS Code) ist „Unten teilen“. Gewählt: `Ctrl+Shift+X` (Explorer ein/aus) und `Ctrl+Shift+O` (Fokus in den Baum; blendet ein, falls nötig). Beide frei, keine `Ctrl+<Buchstabe>` ohne Shift. Der Baum hat den Fokus als Ganzes (`tabIndex=0`, `aria-activedescendant`); seine Tasten hält er mit `stopPropagation` vom Fenster-Handler fern. Da der Fokus nicht im Terminal liegt, erreicht keine Taste die Shell. Escape gibt den Fokus wie die Dialoge über `refocus` zurück. Gebundene Kürzel (z. B. `Ctrl+Shift+X`) laufen weiter über den Fenster-Handler.

### Screenshot-Modus

Neue Fenster des Screenshot-Laufs öffnen ohne Panel (`explorerVisible: false`), denn viele Gruppen zeigen Sessions in `~`, und der Pfad `/home/<name>` in der Kopfzeile nennt den Benutzer. Die Gruppe `explorer` blendet das Panel per Kürzel ein, arbeitet unter `/tmp/termdock-shot-<nonce>` und `C:\Users\Public\termdock-shot-<nonce>` und räumt beide auf. Die Leck-Prüfung liest Kopfzeile und Zeilen des Panels mit und lehnt dort auch `/home/<name>` ab.

## Risks / Trade-offs

- Die Standard-Distro von WSL kann sich zwischen dem Start einer Session und der Abfrage ändern; dann zeigt das Panel für eine solche Session die falsche Distro, bis die Sessionliste neu geladen wird. Selten, und die Prüfung im Main verhindert Zugriffe außerhalb bekannter Distros.
- Ein Ordner, den die Shell gelöscht hat, hat im Core kein Verzeichnis mehr („Verzeichnis unbekannt“).
- Ein Linux-Ordner mit `\` im Namen ist über `\\wsl.localhost` nicht erreichbar (ADR 0009); das Panel zeigt den Fehler des Dienstes.
