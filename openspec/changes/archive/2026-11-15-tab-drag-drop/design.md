# Design

## Kontext

Ein Tab ist ein `LayoutTab` mit einem Pane-Baum aus 1 bis 4 Panes (`ui-store.ts`). Jedes Pane ist eine eigene View (`TerminalController`); bisher zeichnet jeder Tab seine Panes in einem eigenen `.tab-panel` mit der Pane-ID als Schlüssel. Der Core gibt das Schreibrecht nur der ersten View einer Session und hat nach dem Lösen des Schreibers keinen Nachfolger (ADR 0005). Ein Pane, das beim Verschieben neu angehängt würde, wäre danach Leser, und die Session hätte womöglich gar keinen Schreiber mehr. Die Drag-Technik aus #63 (`renderer/drag/`) ist eine reine Zustandsmaschine, ein Controller am Fenster und ein React-Provider, bisher nur in der Sidebar.

## Entscheidungen

### Verschieben ohne neue View

Das Fenster zeichnet die Panes aller Tabs in einer flachen Liste (`.pane-tree`, ein Element je Pane, Schlüssel Pane-ID, Reihenfolge: Tabs, darin Baumreihenfolge). Panes versteckter Tabs sind `visibility: hidden` und behalten ihre Fläche wie vorher die Tabs. Jedes Pane trägt `data-tab-id` und `data-tab-active`, Trenner `data-tab-active`. Ein Pane, das in einen anderen Tab oder an eine andere Stelle wandert, behält so sein Element und seine View: kein `session.detach`, kein `session.attach`, Rolle und Eingabe-Lock bleiben. Ändert sich seine Fläche, passt der Schreiber wie beim Ziehen eines Trenners seine Größe an, ein Leser zoomt. Die Session wird nie verschoben, nur die View; eine Session aus der Sidebar bekommt eine neue View nach den bestehenden Regeln (erste View schreibt, sonst liest sie).

### Regeln an einer Stelle (`layout-moves.ts`, rein)

`applyMove(window, source, target, newId)` liefert das neue `LayoutWindow` oder `undefined`, wenn der Zug nicht erlaubt ist oder nichts ändert. Dieselbe Funktion entscheidet beim Ziehen über gültige Ziele, beim Loslassen über das Ergebnis und in den Kontextmenüs über abgeblendete Einträge. Die Baumfunktionen (`findPane`, `parentOf`, `replaceNode`, Verschmelzen gleichgerichteter Splits, Entfernen eines Panes) wandern dafür aus `ui-store.ts` in `pane-tree.ts`; `UiStore` nutzt sie weiter und bekommt `move(source, target)`.

- Quellen: `tab` (ganzer Baum), `pane` (eine View), `session` (neue View).
- Ziele: Zone eines Panes (`left`, `right`, `top`, `bottom`, `center`) oder die Tab-Leiste vor einem Tab beziehungsweise am Ende.
- Kante: Das Ziel-Pane wird in Richtung `row` (links, rechts) oder `column` (oben, unten) geteilt; liegt es schon in einem Split dieser Richtung, wird das Neue Geschwister und bekommt die Hälfte seines Anteils (wie `splitPane`). Danach verschmelzen gleichgerichtete Splits.
- Mitte: Das Neue ersetzt das Ziel-Pane; dessen View wird gelöst, die Session läuft weiter.
- Grenzen: höchstens 4 Panes je Tab (Kante: Ziel plus Neues; Mitte: Ziel minus 1 plus Neues) und 64 Tabs.
- Nicht erlaubt: ein Pane auf sich selbst, ein Tab auf eines seiner Panes, die Session, die das Ziel-Pane schon zeigt, in die Mitte; ein Tab an seinen eigenen Platz.
- Ergebnis: Ein Quell-Tab ohne Panes entfällt. Aktiv werden der Ziel-Tab und die verschobene View (beim Tab dessen aktives Pane). Eine neue View derselben Session wie das geteilte Pane liest; dann bleibt das geteilte Pane aktiv (Regel von `splitPane`).

### Drag-Technik erweitert

- Ein `DragProvider` je Fenster in `App.tsx` statt in der Sidebar. Bereiche registrieren ihre Regeln mit `useDropHandler({ accepts, onDrop })`; die Sidebar behält ihre Regeln (`sidebar-model.ts`), Tab-Leiste und Panes nutzen `layout-moves.ts`. Ein Ziel gehört dem ersten Bereich, der es annimmt.
- Zonen-Ziele (`drag/drop-zones.ts`, rein): Ein Element mit `data-drop-zones="pane"` oder `"sides"` steht für mehrere Ziele `<id>:<zone>`. Die Trefferfunktion berechnet die Zone aus der Zeigerposition im Element: Pane-Kanten sind die äußeren 30 % (die nächste Kante gewinnt, Grenzen sind die Diagonalen), sonst Mitte; bei Tabs die linke oder rechte Hälfte (`before`, `after`). Ist die Kante nicht erlaubt (4 Panes), gilt die Mitte. So bleibt die Zustandsmaschine unverändert: Ziele sind weiter IDs, gültige Ziele stehen beim Start des Ziehens fest und werden beim Loslassen erneut geprüft.
- Überlagerung: Über dem Pane unter dem Zeiger zeichnet das Fenster die fünf Zonen (SVG, Diagonalen und innerer Rahmen), gesperrte Zonen abgeblendet, und eine Vorschau der Fläche der gewählten Zone; jedes andere gültige Pane ist gestrichelt umrahmt. Auf der Tab-Leiste zeigt ein senkrechter Strich die Einfügestelle.
- Quellen: der Tab selbst (Schwelle 5 Pixel, darunter ist es ein Klick), der Griff oben rechts im Pane, die Zeile der Sidebar. Esc, Loslassen im Leeren und Verlust des Zeigers brechen ohne Änderung ab; der folgende Klick ist unterdrückt.

### Tastatur und Kontextmenü

Dieselben Züge über `applyMove`:

- Tab: Rechtsklick, Menütaste oder Umschalt+F10 öffnet das Menü mit „Nach links verschieben“, „Nach rechts verschieben“ und, für einen anderen als den aktiven Tab, „In den aktiven Tab: links, rechts, oben, unten, Mitte“ (Ziel ist das aktive Pane des aktiven Tabs) sowie „Tab schließen“. `Ctrl+Shift+PageUp`/`PageDown` verschieben den aktiven Tab (wie in VS Code; beide Tasten haben in Shell und tmux ohne Ctrl+Shift keine Bedeutung).
- Pane: Der Griff ist ein Knopf (Tab-Reihenfolge erreichbar, Klick und Menütaste öffnen das Menü): „In eigenen Tab verschieben“, „Nach links/rechts/oben/unten verschieben“ (auf die äußere Kante des Nachbarn in dieser Richtung, `neighborPane`), „Pane schließen“.
- Session in der Sidebar: „Links von / Rechts vom / Über dem / Unter dem aktiven Pane öffnen“ und „Im aktiven Pane öffnen“ im bestehenden Menü, abgeblendet mit Hinweis an der Grenze von 4 Panes.
- Fokus: Nach einem Zug hat das Terminal des aktiven Panes den Fokus (`refocus`); schließt ein Menü ohne Wahl, kehrt der Fokus zum auslösenden Element zurück.

### Speichern

Die Züge ändern nur das `LayoutWindow` im Store; `startLayoutSync` meldet es wie jede andere Änderung, `validateLayoutDocument` bleibt die Prüfung. Reihenfolge der Tabs und Baum stehen so nach einem Neustart wieder da.

## Verworfen

- Pane bei Verschieben neu anhängen und das Schreibrecht danach zurückfordern: kurzzeitig ohne oder mit falschem Schreiber, neue Größe des Leser-Anteils, Verlauf aus dem Snapshot statt der Scrollback des Terminals.
- DOM-Knoten der Terminals zwischen Tab-Elementen umhängen (Portale): React hängt bei geändertem Container neu ein.
- Unsichtbare Zonen-Elemente je Pane als eigene Ziele: Sie entstehen erst nach dem Start des Ziehens und fehlen in der Liste der gültigen Ziele.
- Tab beim Überfahren umschalten, um ein Pane in einen versteckten Tab zu ziehen: nicht im Umfang; der Weg ist der Tab selbst (in den aktiven Tab ziehen) oder das Pane-Menü.

## Risiken

- React verschiebt ein Pane-Element im DOM, wenn sich die Reihenfolge ändert; xterm.js (DOM-Renderer) übersteht das, der Fokus geht verloren und wird mit `refocus` zurückgegeben.
- Viele Ziele: höchstens 64 Tabs und 4 Panes je Tab, je Mausbewegung ein `elementFromPoint` und ein `getBoundingClientRect`.
