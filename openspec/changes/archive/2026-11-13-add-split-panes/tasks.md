# Tasks

## 1. Split-Baum im Store

- [x] 1.1 `splitPane` (neuer Split, gleiche Richtung als Geschwister, Grenze 4, neues Pane aktiv); Tests in `ui-store.test.ts`
- [x] 1.2 `closePane` (Baum vereinfachen, Anteile normieren, letztes Pane schließt den Tab, aktives Pane) und `focusPane`; Tests in `ui-store.test.ts`
- [x] 1.3 `moveDivider` mit Mindestanteil und gleichbleibender Summe; `openSession` findet die Session in jedem Pane; Tests in `ui-store.test.ts`, darunter `validateLayoutDocument` nach Teilen, Ziehen und Schließen
- [x] 1.4 `pane-layout.ts`: Rechtecke der Panes und Trenner aus dem Baum; Tests in `pane-layout.test.ts`

## 2. View

- [x] 2.1 `TerminalController.layoutChanged` gebündelt mit eingespeistem Zeitgeber; Tests in `terminal-controller.test.ts` (mehrere Änderungen → ein `session.resize`, Leser sendet nichts)
- [x] 2.2 `TerminalView`: `proposeSize` ohne Fläche `undefined`, Leser-Darstellung (abgedunkelt, Hinweis), Fokus des aktiven Panes

## 3. Oberfläche

- [x] 3.1 `PaneTree.tsx` (flache Panes, Trenner mit Pointer-Capture), `App.tsx` (Status und Controller je Pane, Klick → Fokus und `claimWriter`), `TabBar.tsx` (Teilen, Pane schließen, Sperre bei 4), `Sidebar.tsx` (Umschalt+Klick), `styles.css`
- [x] 3.2 Screenshot-Szenen (2, 3, 4 Panes, `stty size` vor und nach dem Ziehen, Leser beschnitten, `vim` vor und nach); Lauf `npm run screenshot -w apps/desktop -- <dir>` endet mit Code 0, Bilder geprüft, `tmux -L termdock-test ls` leer

## 4. Abschluss

- [x] 4.1 ADR 0003 und ADR 0006 anpassen
- [x] 4.2 `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test -w apps/desktop`, `bash scripts/openspec-check.sh add-split-panes`

## Workflow follow-up

- `openspec archive add-split-panes -y`, danach `bash scripts/openspec-check.sh --specs`.
