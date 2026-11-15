# Proposal

## Why

Seit #67 lassen sich Tabs und Panes per Drag&Drop anordnen, aber jede Anordnung entsteht Zug um Zug über die Zonen eines Panes. Der Nutzer wünscht fertige Vorschläge wie die Snap Layouts von Windows 11 (#78, Nutzerwunsch 14.11.2026): Beim Ziehen sieht er Muster und direkt, welche Session in welchem Feld landet.

## What Changes

- Muster-Leiste: Zieht der Nutzer einen Tab oder ein Pane an den oberen Rand des Tab-Bereichs, erscheint eine Leiste mit den Mustern „2 nebeneinander“, „2 übereinander“, „1 + 2“, „2 + 1“ und „2 × 2“. Gezeigt werden nur Muster mit Platz für alle Views (höchstens 4 Panes je Tab).
- Jedes Feld zeigt Namen und Statuspunkt der View, die dort landen würde; das Feld des gezogenen Elements ist markiert, freie Felder heißen „leer“.
- Ablegen auf ein Feld ordnet den aktiven Tab nach dem Muster. Panes behalten ihre Views (Rolle, Eingabe-Lock, kein neues Anhängen); ein anderer gezogener Tab geht im aktiven Tab auf. Leere Felder werden nicht angelegt.
- Esc bricht ab und schließt die Leiste.
- Dieselben Muster im Kontextmenü von Tab und Pane-Griff (Tastatur).
- Screenshot-Szenen mit echten Mausereignissen.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: „Abbruch des Ziehens“ geändert; neu „Muster-Leiste beim Ziehen“, „Ablegen auf ein Muster“, „Muster per Kontextmenü“ und „Screenshot-Szenen für Layout-Vorschläge“.

## Impact

- Nur `apps/desktop` (Renderer, Screenshot-Szenen), ADR 0006.
- Kein Vertragswechsel: `packages/protocol` und `packages/core` bleiben unverändert, das Layout behält die Form `LayoutWindow`.
- Non-Goals: Miniatur-Vorschau des Terminalinhalts (optional im Issue, weggelassen), Ziehen zwischen Fenstern (#68), eine Session der Sidebar auf die Leiste, neue Dependencies.
- Security: keine neuen Aufrufe an Main oder Core; Session-Namen gelangen nur als React-Text in die Felder.
- Breaking Changes: keine. Das Kontextmenü von Tab und Pane wird länger.
