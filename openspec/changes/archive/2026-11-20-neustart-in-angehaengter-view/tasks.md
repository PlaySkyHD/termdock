# Tasks

## 1. Renderer

- [x] 1.1 Test und Umsetzung: `restartBar` zeigt die Leiste nur bei `Exited`/`Interrupted`, mit Knopf nur für `writer`, als Hinweis für `reader`, sonst nichts (`apps/desktop/src/renderer/restart-session.test.ts`)
- [x] 1.2 Test und Umsetzung: Ablehnung mit `backend_unavailable` steht in der Leiste, der Knopf ist danach frei; `clearsRestartError` löscht die Meldung bei `Running`, `Detached`, `Archived` und behält sie bei `Starting`, `Exited`, `Interrupted` (`apps/desktop/src/renderer/restart-session.test.ts`)
- [x] 1.3 Leiste in `PaneView` verdrahtet (`PaneTree.tsx`, `styles.css`): Rolle aus `onStatus`, Knopf über `restartFromPlaceholder`, Fokus bleibt in xterm; geprüft durch die Szenen 19c und 19d (`npm run screenshot -w apps/desktop -- <dir> --scenes restore`), 19c prüft per `elementFromPoint`, dass keine Ebene von xterm.js den Knopf verdeckt

## 2. Screenshots und Doku

- [x] 2.1 Szenen `19c-restart-bar-in-view.png` und `19d-restarted-in-view.png` mit Sichtbarkeitsselektor in `screenshot-restore.ts`, Prüfung auf dieselbe View vor und nach dem Neustart; geprüft durch `scene-prefixes.test.ts` und den Screenshot-Lauf
- [x] 2.2 ADR 0006 um die Leiste ergänzt; geprüft durch `bash scripts/openspec-check.sh --specs` nach dem Archivieren
