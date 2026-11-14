# Tasks

## 1. Keymap und Befehle

- [x] 1.1 `keymap.ts` (Tabelle, `resolveKey`, `handleKey`, Übersichtszeilen); Tests in `keymap.test.ts` (Zuordnung, Durchreichen von `Ctrl+C`, `Ctrl+B`, Buchstaben, kein `Ctrl+<Buchstabe>` ohne Shift)
- [x] 1.2 `pane-focus.ts` (Nachbar nach Geometrie); Tests in `pane-focus.test.ts`
- [x] 1.3 `commands.ts` (Tabs, Teilen, Fokus, Sidebar, Kopieren, Einfügen); Tests in `commands.test.ts`

## 2. Terminal und Zwischenablage

- [x] 2.1 `TerminalController`: `onCommand`, `selectedText`, `canPaste`, `paste` (nur Schreiber); Tests in `terminal-controller.test.ts`
- [x] 2.2 `TerminalView`/`PaneTree`: `attachCustomKeyEventHandler`, Rechtsklick fügt ein (nicht bei Mausberichten)

## 3. Oberfläche

- [x] 3.1 `App.tsx` (Fenster-Listener, Befehle, Dialog), `ShortcutsDialog.tsx`, `TabBar.tsx` (Schaltfläche), `styles.css`
- [x] 3.2 Screenshot-Szenen mit echten Tastenereignissen; Lauf `npm run screenshot -w apps/desktop -- <dir>` endet mit Code 0, Bilder geprüft, `tmux -L termdock-test ls` leer

## 4. Abschluss

- [x] 4.1 ADR 0006 ergänzen
- [x] 4.2 `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test -w apps/desktop`, `bash scripts/openspec-check.sh add-keyboard-navigation`

## Workflow follow-up

- `openspec archive add-keyboard-navigation -y`, danach `bash scripts/openspec-check.sh --specs`.
