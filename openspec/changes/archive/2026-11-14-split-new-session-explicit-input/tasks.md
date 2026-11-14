# Tasks

## 1. Teilen startet eine neue Session

- [x] 1.1 `splitActivePane` in `commands.ts` (neue Session mit Launch der aktiven, Name mit freier Nummer, Workspace, kein `command`/`env`/`profileId`, voller Tab, laufendes Teilen, Fehler, verschwundenes Pane); `App.tsx` und `TabBar.tsx` nutzen es; Tests in `commands.test.ts`, zuerst rot gegen den alten Stand; prüfen mit `npm test -w apps/desktop`
- [x] 1.2 Umschalt+Klick mit derselben Session zeigt sie lesend, das geteilte Pane bleibt aktiv; bestehender Test in `ui-store.test.ts` („keeps the split pane active when the new pane shows the same session“) und Screenshot-Szene; prüfen mit `npm test -w apps/desktop`
- [x] 1.3 Tooltips der Sidebar und der Teilen-Knöpfe, Beschriftung der Keymap und Hinweis der Kürzel-Übersicht; Test in `keymap.test.ts` für die Beschriftung; prüfen mit `npm test -w apps/desktop`

## 2. Eingabe nur ausdrücklich übernehmen

- [x] 2.1 Reine Funktion `takesInput` in `pane-layout.ts` (nur Leser, nur Doppelklick, ohne Ziehen) statt `isClick`, angebunden in `TerminalView.tsx`/`PaneTree.tsx`/`App.tsx`; Tests in `pane-layout.test.ts`; prüfen mit `npm test -w apps/desktop`
- [x] 2.2 Knopf „Eingabe übernehmen“ im lesenden Pane und in der Statusleiste, `PASTE_REFUSED` angepasst; Test in `commands.test.ts` für den Text; prüfen mit `npm test -w apps/desktop`

## 3. Zoom lesender Panes

- [x] 3.1 Reine Funktion `readerFontSize` in `terminal-size.ts`; Tests in `terminal-size.test.ts` (passt hinein, Mindestschrift, nie vergrößern, ohne Fläche); prüfen mit `npm test -w apps/desktop`
- [x] 3.2 `TerminalController`: Leser zoomt nach Rolle, `session.resized` und `layoutChanged`, sendet nie `session.resize`; Schreiber setzt vor dem Fit die normale Schrift; `TerminalSurface.setFontSize`/`measure` in `TerminalView.tsx`; Tests in `terminal-controller.test.ts`; prüfen mit `npm test -w apps/desktop`

## 4. Screenshots und Dokumentation

- [x] 4.1 `screenshot-scenario.ts`: Umschalt+Klick für dieselbe Session, einfacher Klick ändert nichts (geprüft gegen tmux), Knopf und Doppelklick übernehmen, gezoomter Leser, Teilen per Knopf und Kürzel mit neuen Sessions; prüfen mit `npm run screenshot -w apps/desktop -- <dir>`
- [x] 4.2 ADR 0003 und ADR 0006 anpassen; prüfen mit `bash scripts/openspec-check.sh split-new-session-explicit-input`
- [x] 4.3 `npm run typecheck`, `npm run lint`, `npm run format:check` grün

## Workflow follow-up

- Change mit `openspec archive split-new-session-explicit-input -y` archivieren und `bash scripts/openspec-check.sh --specs` ausführen.
