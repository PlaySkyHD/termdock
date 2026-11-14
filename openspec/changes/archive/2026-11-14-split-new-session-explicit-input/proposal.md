# Proposal: Teilen startet neue Session, Eingabe-Übernahme nur ausdrücklich

## Why

Beim manuellen Test (14.11.2026, #66) wirkte das Teilen von Panes seltsam. `Ctrl+Shift+D`/`E` und die Teilen-Knöpfe öffnen dieselbe Session im neuen Pane statt einer neuen Shell (`App.tsx`: `split(direction, activeSessionId)`), vier Panes zeigen dieselbe Eingabe. Ein einfacher Klick in ein lesendes Pane übernimmt sofort die Eingabe (`onPaneClick` → `claimWriter`); die Session bekommt dessen Größe, alle anderen Panes werden abgeschnitten oder bekommen einen leeren Rand, und bei jedem Klick springt das Bild.

## What Changes

- **Teilen startet eine neue Session** mit Backend, Distribution, Windows-Shell und Arbeitsverzeichnis (`launch.cwd`) der Session des aktiven Panes und deren Workspace (`session.create`). Das neue Pane zeigt sie, wird aktiv und schreibt; jedes Pane hat eigene Shell und Größe.
- **Dieselbe Session in einem zweiten Pane** nur ausdrücklich per Umschalt+Klick in der Sidebar (gibt es schon). Tooltips der Sidebar und der Teilen-Knöpfe sowie die Kürzel-Übersicht sagen das.
- **Eingabe übernehmen nur ausdrücklich:** Ein Klick in ein lesendes Pane macht es nur aktiv. Übernahme über den Knopf „Eingabe übernehmen“ (im lesenden Pane und in der Statusleiste) oder per Doppelklick. Schreiber und Größe ändern sich beim einfachen Klick nicht.
- **Lesende Panes zoomen auf das Raster des Schreibers** (Nutzerentscheidung 14.11.2026, Variante A): Die Schriftgröße wird verkleinert, bis das ganze Raster hineinpasst, nie über die normale Größe; unter der Mindestschrift wird wie bisher abgeschnitten. Die Berechnung ist eine reine Funktion.
- Screenshot-Modus: Szenen für dieselbe Session nutzen Umschalt+Klick, neue Szenen für den gezoomten Leser und die ausdrückliche Übernahme; Teilen per Kürzel erzeugt neue Sessions.
- ADR 0003 und ADR 0006 beschreiben Zoom, Teilen und Übernahme.

## Non-Goals

- Kein neues Protokollfeld: `packages/protocol` und `packages/core` bleiben unverändert. Das aktuelle Verzeichnis der Shell (nach `cd`) kennt das Protokoll nicht; Teilen nutzt `launch.cwd`.
- Variante B (kleinstes Pane bestimmt die Größe wie tmux) ist verworfen, siehe Design.
- Kein Beenden der neuen Session, wenn das Teilen danach scheitert (das Protokoll hat kein `session.kill` über die Brücke); sie öffnet dann in einem eigenen Tab.

## Capabilities

### New Capabilities

Keine.

### Modified Capabilities

- `desktop-shell`: Teilen, Eingabe-Lock (ausdrückliche Übernahme) und Darstellung lesender Views (Zoom).

## Impact

- `apps/desktop/src/renderer`: `commands.ts` (Teilen mit neuer Session), `App.tsx`, `TabBar.tsx`, `Sidebar.tsx`, `ShortcutsDialog.tsx`, `keymap.ts` (Beschriftung), `StatusBar.tsx`, `TerminalView.tsx`, `PaneTree.tsx`, `pane-layout.ts` (Klick-Absicht), `terminal-size.ts` (Zoom), `terminal-controller.ts` (Zoom im Leser, normale Schrift im Schreiber), `styles.css`, Tests.
- `apps/desktop/src/main/screenshot-scenario.ts`: angepasste und neue Szenen.
- Brücke und IPC unverändert (`createSession` gibt es schon).
- Sicherheit: Die neue Session übernimmt weder `command` noch `env` noch `profileId` der aktiven Session; kein Shell-String, nur Felder des Launch-Spec.
