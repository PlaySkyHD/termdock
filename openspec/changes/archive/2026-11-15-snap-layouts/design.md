# Design

## Kontext

Ein Tab hat einen Pane-Baum aus 1 bis 4 Panes. Seit #67 zeichnet das Fenster alle Panes in einer flachen Liste mit der Pane-ID als Schlüssel; ein Zug ändert nur den Baum, und jedes Pane behält sein Element und seine View (ADR 0006). Alle Regeln stehen in `applyMove` (`layout-moves.ts`); Drag&Drop, Kontextmenüs und Store fragen dieselbe Funktion. Die Zustandsmaschine (`drag-model.ts`) sammelt die gültigen Ziele beim Start des Ziehens.

## Entscheidungen

### Muster als weiterer Zug (`snap-layouts.ts`, rein)

- Neues Ziel `{ kind: "snap", pattern, slot }` in `MoveTarget`; `applyMove` ruft `applySnap`. So gelten Drop, Menü und `UiStore.move` ohne eigene Wege.
- Muster als Form aus Feldern in Lesereihenfolge: `columns` (row 0|1), `rows` (column 0/1), `mainLeft` „1 + 2“ (row 0 | column 1/2), `mainRight` „2 + 1“ (row column 0/1 | 2), `grid` „2 × 2“ (column aus zwei rows 0|1, 2|3). Gleiche Anteile; neue Splits bekommen neue IDs.
- Angeordnet wird immer der aktive Tab. Die gezogene View kommt in das gewählte Feld, die übrigen Views füllen die anderen Felder in Baumreihenfolge. Gezogenes Pane: es selbst (aus einem anderen Tab herausgelöst; ein leerer Tab schließt). Gezogener Tab: sein aktives Pane; ist es ein anderer Tab, folgen nach den Views des aktiven Tabs seine übrigen Panes, und er schließt. Eine Session der Sidebar wird nicht angeboten (Issue: Tab oder Pane).
- Abgelehnt (`undefined`): mehr Views als Felder, mehr als 4 Views, ein ungültiges Feld, kein aktiver Tab, und ein Ergebnis gleich dem jetzigen Baum (Split-IDs zählen nicht) mit gleichem aktiven Pane.
- Ergebnis: Die gezogene View wird aktives Pane, der aktive Tab bleibt aktiv. Panes behalten ID und Session, also View, Rolle und Eingabe-Lock; kein `session.detach`, kein `session.attach`.

### Leere Felder werden nicht angelegt

Ein Muster mit mehr Feldern als Views ist erlaubt, die freien Felder heißen in der Leiste „leer“. Beim Ablegen entfallen sie: Ein Split mit einem Kind weicht dem Kind, die übrigen Felder teilen sich die Fläche. Begründung: Ein `LayoutPane` zeigt immer eine Session (`sessionId` ist Pflicht im Protokoll); ein leeres Pane bräuchte ein neues Layout-Format in `packages/protocol` und einen eigenen Platzhalter ohne Funktion. Ein Pane ohne View würde zudem Platz belegen, den der Nutzer danach erst wieder schließen müsste.

### Muster-Leiste (`SnapBar.tsx`)

- Die Leiste liegt oben mittig über dem Tab-Bereich (`.tab-panels`, über den Panes). Ihre Felder sind normale Ziele (`data-drop-target="snap:<muster>:<feld>"`, `layout-drop.ts`). Sie bleibt immer im DOM (versteckt, `display: none`), weil die Zustandsmaschine die gültigen Ziele beim Start des Ziehens sammelt; ein erst beim Ziehen eingehängtes Element fehlte dort (wie im Design von #67 verworfen).
- Öffnen (`snapBarOpen`, rein): Der Zeiger steht in den oberen 32 Pixeln des Tab-Bereichs (nicht darüber in der Tab-Leiste, nicht seitlich daneben). Offen bleibt sie, solange der Zeiger über ihr oder 16 Pixel daneben steht. Sie öffnet nur, wenn mindestens ein Feld gültig ist.
- Sichtbar sind die Muster mit mindestens einem gültigen Feld. Jedes Feld zeigt Namen und `StateIcon` der View, die dort landen würde, für das Feld unter dem Zeiger berechnet, sonst für das erste Feld. Das Feld der gezogenen View ist blau umrandet, das Feld unter dem Zeiger gefüllt, freie Felder gestrichelt mit „leer“.
- Esc, Loslassen im Leeren und Verlust des Zeigers beenden das Ziehen wie bisher; die Leiste schließt, weil sie nur in der Phase `dragging` offen ist.

### Tastatur und Kontextmenü

Die Menüs von Tab und Pane-Griff (`layout-menus.ts`) bekommen je Muster einen Eintrag: „Anordnen: <Muster>“ für den aktiven Tab und ein Pane, „Mit dem aktiven Tab anordnen: <Muster>“ für einen anderen Tab. Das Element kommt in das erste Feld. Gesperrte Einträge nennen den Grund: „Höchstens 4 Panes je Tab“, „Zu wenige Felder für alle Panes“ oder „Ändert nichts“. Danach hat das aktive Terminal den Fokus (`refocus`).

### Speichern

Nur das `LayoutWindow` im Store ändert sich; `startLayoutSync` meldet es, `validateLayoutDocument` bleibt die Prüfung, `loadWindow` stellt es wieder her.

## Verworfen

- Leere Felder als Platzhalter-Panes: siehe oben, bräuchte einen Vertragswechsel.
- Die Leiste erst beim Ziehen einhängen und die Zustandsmaschine die gültigen Ziele neu sammeln lassen: mehr Änderung an `drag-model.ts` für denselben Effekt.
- Miniatur-Vorschau des Terminalinhalts (optional im Issue): ein Abbild je View beim Ziehen kostet Zeichenzeit und Speicher, der Nutzen gegenüber Name und Status ist klein. Weggelassen.
- Feldwahl im Menü (14 Einträge): Das Menü legt das Element ins erste Feld; jede andere Anordnung entsteht über Tauschen.

## Risiken

- Die Leiste deckt oben die Zonen der obersten Panes ab, solange sie offen ist. Die obere Zone eines Panes reicht 30 % in das Pane, darunter bleibt sie erreichbar.
- Die Leiste liest beim Rendern die Box des Tab-Bereichs und ihre eigene; das sind zwei `getBoundingClientRect` je Mausbewegung beim Ziehen.
