# Tasks

## 1. Brücke

- [x] 1.1 Aufruf `coreStatus` (Typen, Preload, `parseCall`, `dispatch`); Test in `bridge.test.ts`
- [x] 1.2 Event `sessionCreated` an alle Fenster nach `createSession`; Test in `bridge.test.ts`

## 2. UI-Store und Anzeigemodell

- [x] 2.1 `ui-store.ts`: Tab öffnen, fokussieren, schließen, Duplikat, Limit, Sidebar; Tests in `ui-store.test.ts`
- [x] 2.2 Sessions und Zustandswechsel im Store; Tests in `ui-store.test.ts`
- [x] 2.3 `session-display.ts`: Gruppen, Zustandsbezeichnung, Text der Statusleiste; Tests in `session-display.test.ts`
- [x] 2.4 `session-sync.ts`: Brücke in den Store mit Pufferung bis zur Liste; Tests in `session-sync.test.ts`

## 3. Oberfläche

- [x] 3.1 `Sidebar.tsx`, `TabBar.tsx`, `StatusBar.tsx`, `App.tsx`, `TerminalView.tsx` umbauen (Tabs bleiben angehängt), `styles.css`; `start-session.ts` entfernen
- [x] 3.2 Menü „Neues Fenster“ im Main
- [x] 3.3 Screenshot-Szenario; prüfen im Lauf `npm run screenshot -w apps/desktop -- <dir>`

## 4. Abschluss

- [x] 4.1 ADR 0006 ergänzen
- [x] 4.2 Typecheck, Lint, Format, Tests, `openspec-check.sh`, Archivieren
