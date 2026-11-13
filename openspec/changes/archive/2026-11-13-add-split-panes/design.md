# Design

## Context

Nach #26 hält `ui-store.ts` je Fenster ein `LayoutWindow`; jeder Tab hat genau ein `LayoutPane`. `packages/protocol` kennt seit #25 `LayoutSplit` und `PaneNode`, `validateLayoutDocument` prüft höchstens 4 Panes je Tab, mindestens 2 Kinder je Split und `sizes` mit Summe 1 ± 0,01. `TerminalController` ist eine View (Snapshot, Ausgabe-Sequenz, Rollen); `layoutChanged()` passt den Schreiber sofort an und sendet `session.resize`. Inaktive Tabs bleiben angehängt und werden nur versteckt (`visibility: hidden`, gleiche Fläche, ADR 0006). Motivation: proposal.md.

## Goals / Non-Goals

**Goals:**

- Ein reiner Split-Baum im Store, den #28 (Tastenkürzel) und #29 (Wiederherstellung) ohne Umbau nutzen.
- Keine Resize-Stürme beim Ziehen; der Core sieht Größen nur vom Schreiber.
- Leser zeigen den Bildschirm des Schreibers unverfälscht.

**Non-Goals:** siehe Proposal. Der Store kennt keine Pixel; Mindestgrößen in Pixeln rechnet die Oberfläche in einen Anteil um.

## Decisions

### Split-Baum im Store

Neue Aktionen, alle rein und mit unverändertem Zustand bei ungültigen Argumenten:

- `splitPane(tabId, paneId, direction, sessionId)` → neue Pane-ID oder `undefined`. Gesperrt, wenn der Tab schon `MAX_PANES_PER_TAB` (4) Panes hat. Hat der Elternknoten des Panes dieselbe Richtung, wird das neue Pane als Geschwister direkt dahinter eingefügt und das geteilte Pane gibt die Hälfte seines Anteils ab (drei Spalten statt verschachtelter Splits). Sonst ersetzt ein neuer Split `[pane, neu]` mit `[0.5, 0.5]` das Pane. Zeigt das neue Pane eine andere Session, wird es aktiv; zeigt es dieselbe, liest seine View, und das geteilte (schreibende) Pane bleibt aktiv und fokussiert, sonst ginge Tippen ins Leere (Review PR #36). Beide Fälle halten die Tiefe so klein, dass die Prüfung „Split auf Tiefe ≥ 3“ bei 4 Panes nie greift.
- `closePane(tabId, paneId)`: entfernt das Blatt; die Anteile der übrigen Geschwister werden auf Summe 1 normiert; ein Split mit einem Kind wird durch dieses Kind ersetzt, und ein Split, der danach direkt in einem Split gleicher Richtung liegt, verschmilzt mit ihm (Anteile multipliziert). Das letzte Pane schließt den Tab (`closeTab`). Aktiv wird das erste Pane des Geschwisters, das an die Stelle rückt (sonst das davor).
- `focusPane(tabId, paneId)`: aktives Pane setzen, ohne Änderung kein Event.
- `moveDivider(tabId, splitId, index, delta, minShare)`: verschiebt die Grenze zwischen Kind `index` und `index + 1` um `delta` (Anteil). Das Delta wird so begrenzt, dass beide Kinder mindestens `minShare` behalten; die Summe bleibt exakt gleich. Die Oberfläche übergibt `max(MIN_SHARE, MIN_PANE_PX / Splitgröße)`.
- `openSession` fokussiert jetzt den Tab, in dem irgendein Pane die Session zeigt, und macht dieses Pane aktiv. `tabSessionId` (Titel, Sidebar-Markierung) bleibt die Session des aktiven Panes.

Alternative: Größen in Pixeln oder Spalten speichern. Verworfen, weil `LayoutSplit.sizes` Anteile sind und das Layout zwischen Fenstergrößen übertragbar bleiben soll (#29).

### Welche Session zeigt ein neues Pane?

Teilen über die Tab-Leiste zeigt **dieselbe Session als weitere View**; Umschalt+Klick auf eine Session in der Sidebar teilt das aktive Pane mit **dieser** Session (rechts). Gründe: `LayoutPane.sessionId` ist Pflicht, ein leeres Pane gibt es im Format nicht. Eine automatisch angelegte Session würde langlebige, gespeicherte Sessions (Kapitel 4, ADR 0004) nebenbei erzeugen, die der Benutzer nicht gewollt hat, und braucht bei kaltem WSL bis zu 60 s. Eine Auswahl im Pane wäre ein eigener Dialog ohne Gegenstück im Layout. Die weitere View derselben Session ist sofort da und ist zugleich der Fall „ein Leser im selben Fenster“, den die Abnahme verlangt. Strg+Klick (neuer Tab) und Umschalt+Klick (Split) bilden ein einheitliches Muster; Tastenkürzel ergänzt #28.

### Panes in der Oberfläche

Jedes Blatt ist ein `PaneView` mit eigener `TerminalView` (eigener Controller, eigene View im Core). Ein rekursiver Aufbau aus verschachtelten Flex-Containern wurde verworfen: Wird ein Split durch sein letztes Kind ersetzt oder ein Pane in einen neuen Split gelegt, ändert sich die React-Struktur über dem Pane, und React würde die View lösen und neu anhängen. `PaneTree.tsx` zeichnet deshalb alle Blätter eines Tabs als flache Liste absolut positionierter Elemente mit der Pane-ID als `key`; ihre Rechtecke (Anteile des Tabs) und die Trenner berechnet `layoutPanes` in `pane-layout.ts` rein aus dem Baum. Die Trenner liegen als eigene Ebene darüber (1 px Linie, 7 px Greiffläche).

Statusleiste, „Schreibrecht übernehmen“ und Fokus beziehen sich auf das aktive Pane des aktiven Tabs; Status und Controller liegen je Pane-ID. Das aktive Pane trägt bei mehr als einem Pane einen Rahmen in der Akzentfarbe. Ein `mousedown` (Capture-Phase, weil xterm.js Mausereignisse an Programme wie vim selbst behandelt) macht das Pane aktiv und ruft, wenn seine View liest, `claimWriter`.

Schaltflächen „Rechts teilen“, „Unten teilen“ und „Pane schließen“ stehen rechts in der Tab-Leiste und wirken auf das aktive Pane; bei 4 Panes sind die Teilen-Schaltflächen gesperrt (Titel nennt die Grenze), „Pane schließen“ nur bei mehr als einem Pane.

### Trenner ziehen

Pointer-Events mit `setPointerCapture` auf dem Trenner; jede Bewegung nimmt die Position des Zeigers als Anteil des Tabs, zieht die aktuelle Position des Trenners ab, rechnet die Differenz in einen Anteil des Splits um und ruft `moveDivider`. Weil die Zielposition absolut ist, läuft der Trenner nach einem Anschlag am Mindestanteil nicht vom Zeiger weg. Mindestgröße 80 px je Seite, mindestens 5 %.

### Gebündelte Größe

`TerminalController.layoutChanged()` passt nicht mehr sofort an, sondern plant einmal eine Anpassung nach `LAYOUT_DELAY_MS` (60 ms); weitere Änderungen in dieser Zeit ändern nichts am Plan, die Anpassung liest die Fläche erst beim Ablauf. So entstehen beim Ziehen höchstens etwa 16 Anpassungen je Sekunde, und am Ende steht immer die letzte Größe. `session.resize` geht wie bisher nur bei geänderter Größe und nur vom Schreiber. Der Zeitgeber ist eingespeist (Test ohne echte Zeit). Rollenwechsel (`writerChanged`) passen weiter sofort an. Alternative `requestAnimationFrame`: würde beim Ziehen bis zu 60 Anfragen je Sekunde an tmux schicken; verworfen. Reine Nachlauf-Verzögerung (Debounce): während des Ziehens gar keine Anpassung; verworfen.

Fenstergröße und Sidebar ändern die Fläche, die `ResizeObserver` je Pane meldet; sie laufen über denselben Weg. Versteckte Tabs behalten ihre Fläche (`visibility: hidden`), ein Pane darin meldet also nur dann eine Änderung, wenn sich die Fläche wirklich ändert, und berechnet dieselbe Größe wie sichtbar. Zusätzlich liefert `proposeSize` `undefined`, solange das Element keine Fläche hat (Breite oder Höhe 0); dann wird nichts gesendet.

### Lesende Views

Der Leser stellt das Terminal in der Größe des Schreibers dar (`term.resize`, wie bisher), skaliert nicht und schneidet ab (`overflow: hidden`). Neu: Nach dem Zeichnen misst `TerminalView` den Bildschirm von xterm.js (`.xterm-screen`) und legt einen Rahmen darauf, dessen Schatten (`box-shadow`) alles um den Bildschirm abdunkelt; ein Hinweis unten rechts im Pane nennt „Größe des Schreibers: C×R“. Die Rolle kommt aus `ViewStatus`, den `TerminalView` jetzt auch selbst auswertet. Alternative: das xterm-Element per CSS auf die Größe seines Bildschirms schrumpfen. Verworfen, weil xterm.js 6 Viewport und Scrollbereich absolut über das ganze Element legt und deren Maße keine öffentliche Schnittstelle sind.

Beim Prüfen der Screenshots fiel auf, dass die letzte Zeile jedes Terminals abgeschnitten war (bei vim die Befehlszeile): Das Fit-Addon liest die berechnete Höhe des Elternelements und zieht nur den Innenabstand des xterm-Elements ab. `.terminal-view` bekommt deshalb `box-sizing: content-box` mit `height: calc(100% - 4px)`, so dass die berechnete Höhe genau die Fläche für die Zeilen ist. Innenabstand auf dem xterm-Element selbst wurde verworfen, weil xterm.js dort seinen schwarzen Viewport und die Scrollleiste zeichnet.

### Screenshot-Modus

Neue Szenen in einem dritten Fenster (1280×800) nach den bisherigen, mit vier weiteren Sessions („Shell“, „Editor“, „Misc“, „Vim“) und „Notes“:

- „Shell“ öffnen, „Rechts teilen“ (zweite View derselben Session, Leser), Trenner auf 68 % ziehen: Leser beschnitten mit Hinweis. Die Zeilen von Leser und Schreiber werden verglichen (doppelte Ausgabe würde sie verschieben). Klick in den Leser: er schreibt, das andere Pane liest und ist um den Bildschirm abgedunkelt.
- „Editor“ öffnen, Umschalt+Klick auf „Misc“, in beiden `stty size`; Trenner auf 70 %, erneut `stty size`. Der Lauf prüft, dass die Spalten links wachsen, rechts schrumpfen und mit `#{pane_width}` von tmux übereinstimmen.
- Umschalt+Klick auf „Notes“ (3 Panes), „Unten teilen“ (4 Panes, Teilen gesperrt).
- „Vim“: `seq 1 300 | vim -u NONE …`, Cursor auf Zeile 152; „Rechts teilen“ (eine View hängt sich an, während vim läuft), Trenner ziehen. Vor und nach jeder Änderung vergleicht der Lauf die Cursorposition im xterm-DOM mit `#{cursor_x} #{cursor_y}` von tmux.

Mausereignisse für Klicks ins Pane und das Ziehen kommen über `webContents.sendInputEvent` (beim Ziehen mit `leftbuttondown`), damit Pointer-Capture wie beim Benutzer greift. Jede Warte- oder Prüfstelle wirft bei Zeitüberschreitung oder Abweichung; der Lauf endet dann mit Code 1. Der Gesamt-Timeout steigt auf 360 s.

## Risks / Trade-offs

- [Dieselbe Session zweimal im selben Fenster] → Die Sequenzmarke (ADR 0006) verhindert doppelte Ausgabe bis auf die bekannte Restlücke (#34); nicht Teil dieses Changes.
- [Viele Terminals] → höchstens 4 Panes je Tab, also bis zu 256 xterm.js-Instanzen je Fenster bei 64 Tabs; wie bisher erst bei extremer Nutzung messbar.
- [60 ms Verzögerung] → Beim Ziehen hinkt das Terminal kurz hinterher; der Leser-Hinweis und das Abschneiden verdecken nichts Falsches.
- [Absolut positionierte Panes] → Rechtecke aus Anteilen; Rundung kann ein Pixel Lücke erzeugen, der Hintergrund ist gleichfarbig.
