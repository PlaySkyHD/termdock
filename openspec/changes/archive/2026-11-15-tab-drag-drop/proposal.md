# Proposal

## Why

Tabs und Panes lassen sich bisher nur über Teilen, Schließen und Trenner verändern; ihre Reihenfolge und Anordnung steht nach dem Öffnen fest. Der Nutzer will sie wie in VS Code per Drag&Drop anordnen (#67, Konzept Kap. 3 „Tabs; 2–4 Split-Panes“, Abnahme 06 und 08). Die Drag-Technik aus #63 (`renderer/drag/`) ist dafür vorbereitet.

## What Changes

- Tabs in der Tab-Leiste umsortieren; die Reihenfolge steht im gemeldeten Layout.
- Einen Tab auf ein Pane ziehen: eine Überlagerung zeigt fünf Zonen (links, rechts, oben, unten teilen, die Mitte ersetzt die View des Panes). Zonen, die mehr als 4 Panes ergäben, sind nicht wählbar.
- Ein Pane über seinen Griff auf ein anderes Pane oder auf die Tab-Leiste ziehen (eigener Tab); ein leerer Tab schließt.
- Eine Session aus der Sidebar auf ein Pane ziehen öffnet sie dort als neue View der Session.
- Gezogen werden Views, nie Sessions: Ein verschobenes Pane bleibt dieselbe View (kein `session.detach`/`session.attach`), behält damit Rolle und Eingabe-Lock. Dazu zeichnet das Fenster die Panes aller Tabs in einer flachen Liste mit der Pane-ID als Schlüssel.
- Tastatur und Kontextmenü: Kontextmenü am Tab (verschieben, in den aktiven Tab einfügen), am Griff des Panes (eigener Tab, in eine Richtung verschieben) und an der Session (im aktiven Pane öffnen); `Ctrl+Shift+PageUp`/`PageDown` verschieben den aktiven Tab.
- Die Drag-Technik wird erweitert, nicht verdoppelt: ein `DragProvider` je Fenster mit registrierten Zielregeln und Zonen-Zielen.
- Screenshot-Szenen mit echten Mausereignissen.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: „Tabs öffnen, wechseln, schließen“ und „Abbruch des Ziehens“ geändert; neu „Tabs und Panes per Drag&Drop anordnen“, „Anordnen per Tastatur und Kontextmenü“ und „Screenshot-Szenen für das Anordnen“.

## Impact

- Phase 3 (Konzept Kap. 12), nur Paket `apps/desktop` (Renderer, Screenshot-Szenen), ADR 0006.
- Kein Vertragswechsel: `packages/protocol` und `packages/core` bleiben unverändert; das Layout behält die Form `LayoutWindow`, keine neue IPC-Methode.
- Non-Goals: Ziehen zwischen Fenstern (#68), Umschalten des Tabs beim Überfahren während des Ziehens, Sessions auf die Tab-Leiste ziehen, neue Dependencies.
- Security: keine neuen Aufrufe an Main oder Core; Namen gelangen nur als React-Text in Schatten und Menüs.
- Breaking Changes: keine. Die Screenshot-Szenen finden Panes über `data-tab-active` statt über `.tab-panel`.
