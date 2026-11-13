# Proposal

## Why

Nach #26 zeigt jeder Tab genau eine View. Phase 2 (Kapitel 12, „Desktop-Erlebnis“, Abnahme 06) verlangt 2–4 Split-Panes je Tab mit korrekter Größenänderung (Issue #27). ADR 0003 ließ offen, ob lesende Views skaliert oder beschnitten werden; ADR 0006 hat „beschnitten“ festgelegt, die Darstellung in Panes fehlt noch.

## What Changes

- **Split-Baum im UI-Store:** Ein Pane wird rechts (`row`) oder unten (`column`) geteilt, ein Pane geschlossen (der Baum vereinfacht sich, ein Split mit einem Kind entfällt), Größenverhältnisse (`sizes`, Summe 1, Mindestanteil) und aktives Pane. Höchstens 4 Panes je Tab (`MAX_PANES_PER_TAB`), das fünfte Teilen ist gesperrt. Der Baum bleibt `PaneNode` aus `packages/protocol` und besteht `validateLayoutDocument`.
- **Panes in der Oberfläche:** je Pane eine View (`TerminalController`). Teilen und Pane schließen über Schaltflächen in der Tab-Leiste; das neue Pane zeigt dieselbe Session als weitere View. Umschalt+Klick in der Sidebar teilt das aktive Pane mit der angeklickten Session. Schließen eines Panes löst seine View (`session.detach`), das letzte Pane schließt den Tab.
- **Trenner** mit der Maus ziehen (Mindestgröße je Pane). Fit und `session.resize` nur in der schreibenden View, gebündelt mit kurzer Verzögerung; Fenstergröße und Sidebar wirken genauso.
- **Fokus:** Das aktive Pane ist markiert; ein Klick hinein fokussiert es und übernimmt das Schreibrecht (`session.claimWriter`).
- **Lesende Views:** Terminal in der Größe des Schreibers, beschnitten, Rest abgedunkelt, Hinweis „Größe des Schreibers: C×R“. Nicht skalieren.
- **Screenshot-Modus:** 2, 3 und 4 Panes, `stty size` vor und nach dem Ziehen eines Trenners, dieselbe Session in zwei Panes (eines lesend), `vim` vor und nach der Größenänderung.
- ADR 0003 und ADR 0006 angepasst.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: ADDED Split-Panes, Trenner und gebündelte Größe, aktives Pane mit Schreibrecht per Klick, Darstellung lesender Views; MODIFIED UI-Store (Pane-Baum statt genau ein Pane), Tabs (Anhängen je Pane), Screenshot-Modus.

## Impact

- Geändert: `apps/desktop/src/renderer/**` (Store, App, neue Pane-Ansicht, Tab-Leiste, Sidebar, TerminalView, Controller, CSS), `apps/desktop/src/main/screenshot-scenario.ts` und `main.ts` (Szenen, Gesamt-Timeout), `docs/adr/0003-*.md`, `docs/adr/0006-*.md`.
- IPC-Methoden: keine neuen; genutzt werden `session.attach`, `session.detach`, `session.resize`, `session.claimWriter` wie bisher, nur je Pane. Datenmodelle unverändert (`LayoutSplit`, `PaneNode` gibt es seit #25).
- Dependencies: keine neuen.
- Non-Goals: Tastenkürzel für Teilen und Fokuswechsel (#28), Speichern und Wiederherstellen des Layouts (#29), Panes zwischen Tabs ziehen, Session eines Panes nachträglich wechseln, Skalieren lesender Views, die Restlücke doppelter Ausgabe bei zwei Views im selben Fenster (#34).
- Security: unverändert; keine neuen Brückenaufrufe. Der Screenshot-Modus ruft `wsl.exe` weiter nur mit festem Argument-Array gegen den Socket `termdock-test` auf.
- Breaking Changes: keine. Ein Tab mit einem Pane verhält sich wie bisher.
