# Proposal

## Why

Tabs und Panes lassen sich seit #67 nur innerhalb ihres Fensters anordnen. Wer mit mehreren Fenstern arbeitet (Ctrl+Shift+N, Mehrfenster-Layout aus #29), muss eine Session im Zielfenster neu öffnen und im Quellfenster schließen; dabei geht das Schreibrecht verloren, und das neue Pane liest. Der Nutzer will einen Tab oder ein Pane in ein anderes TermDock-Fenster ziehen oder durch Ziehen nach außen ein neues Fenster öffnen (#68, Konzept Kap. 3 „Tabs; 2–4 Split-Panes“, Abnahme 05 und 08).

## What Changes

- Ein Tab (Tab-Leiste) oder ein Pane (Griff) lässt sich über den Rand seines Fensters hinaus ziehen. Der Main-Prozess koordiniert den Zug: Er rechnet die Zeigerposition in Bildschirmkoordinaten um, findet das Fenster darunter und meldet ihm die Position, damit es dieselben Ziele wie bei #67 hervorhebt (Tab-Leiste, fünf Zonen eines Panes).
- Ablegen über einem anderen Fenster setzt den Tab oder das Pane dort nach den Regeln von `applyMove` ein. Ablegen außerhalb aller Fenster öffnet ein neues Fenster an der Mausposition mit dem Element als einzigem Tab. Ist das Element der ganze Inhalt seines Fensters, wandert stattdessen das Fenster selbst dorthin.
- Die View wechselt das Fenster und behält ihre Rolle: Das Zielfenster hängt eine neue View an (sie liest, solange die alte da ist), der Main überträgt einem vorherigen Schreiber das Schreibrecht atomar mit `session.claimWriter`, erst dann löst das Quellfenster seine alte View. Der Core sieht je View genau ein `session.attach` und ein `session.detach`; es gibt keinen Moment mit zwei Schreibern und keinen ohne Schreiber, wenn vorher einer da war.
- Wird der letzte Tab eines Fensters herausgezogen, schließt das Quellfenster ohne Schließen-Dialog, ohne eine Session zu beenden, und verlässt das Layout.
- Scheitert die Übergabe (Ziel lehnt ab, Anhängen scheitert, Zeitlimit, Fenster geschlossen), bleibt alles im Quellfenster, und das Ziel entfernt, was es schon eingesetzt hat.
- Das Layout nach der Übergabe wird wie jede Änderung gemeldet und gespeichert; nach dem Neustart stehen Tab und Pane im neuen Fenster.
- Screenshot-Szenen mit zwei Fenstern (neue Gruppe `drag`).

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: neu „Tabs und Panes zwischen Fenstern ziehen“, „Übergabe der View zwischen Fenstern“ und „Screenshot-Szenen für das Ziehen zwischen Fenstern“.

## Impact

- Phase 3 (Konzept Kap. 12, Produktfunktionen; aus #67 zurückgestellt und nach V1 umgesetzt), Paket `apps/desktop` (Main, Preload, Brücke, Renderer, Screenshot-Szenen), ADR 0006.
- Brücke Renderer ↔ Main: vier neue Aufrufe (`transferHover`, `transferHoverEnd`, `transferDrop`, `transferAttached`) und vier Events (`transferHover`, `transferIn`, `transferCancel`, `transferOut`), alle im Main geprüft.
- Kein Vertragswechsel mit dem Core: `packages/protocol` und `packages/core` bleiben unverändert, die Übergabe nutzt `session.attach`, `session.claimWriter` und `session.detach`. Ein Core-Test hält die Reihenfolge als Vertrag fest.
- Non-Goals: Sessions aus der Sidebar in ein anderes Fenster ziehen, Layout-Vorschläge (#78) im Zielfenster, Ziehen zwischen zwei App-Instanzen, natives HTML5-Ziehen, neue Dependencies.
- Security: Der Main prüft jedes übertragene Element wie ein Layout (`validateLayoutDocument`) und nimmt nur Views des aufrufenden Fensters; Namen und IDs gelangen nur als Daten in das Zielfenster.
- Breaking Changes: keine.
