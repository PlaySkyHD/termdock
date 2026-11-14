# Tasks

## 1. Modi verfolgen (Core)

- [x] 1.1 Reines Modul `packages/core/src/session/terminal-modes.ts` mit Tests in `terminal-modes.test.ts`: Setzen und Zurücksetzen je Modus, Mausprotokoll und Kodierung, Sequenz über zwei Chunks, RIS und DECSTR, feste Reihenfolge von `sequence()`, Obergrenze für unvollständige Sequenzen; prüfen mit `npm test -w packages/core`
- [x] 1.2 `SessionRegistry` füttert die Modi in `bindPty`, stellt `sequence()` in `attachView` dem Snapshot voran (Backend und Puffer) und setzt sie bei `restart` (und `archive`, mit dem Puffer) zurück; Tests in `registry.test.ts` für die Szenarien aus der Spec, zuerst rot ohne Umsetzung

## 2. WSL-Integration

- [x] 2.1 WSL-Integrationstest in `packages/core/src/e2e.wsl.test.ts` (Socket `termdock-test`): `mouse on` für die Session (Session-Option statt `-g`, damit andere Tests auf dem Socket unberührt bleiben), `less`, View A und spät angehängte View B haben dieselben Modi (`@xterm/headless`, `terminal.modes`); ohne Fix rot; prüfen mit `TERMDOCK_WSL_TESTS=1 npm test -w packages/core`

## 3. Desktop

- [x] 3.1 Umgehung `bracketedPaste` aus `TerminalController`, `TerminalView.tsx` und `PaneTree.tsx` samt Test entfernen, Kommentar in `screenshot-scenario.ts` anpassen; prüfen mit `npm test -w apps/desktop` und einem Screenshot-Lauf (Szene „paste-bracketed“ besteht weiter)

## 4. Dokumentation und Abschluss

- [x] 4.1 ADR 0003 (Snapshot-Inhalt mit Modi) anpassen; prüfen mit `bash scripts/openspec-check.sh snapshot-terminal-modes`
- [x] 4.2 `npm run typecheck`, `npm run lint`, `npm run format:check` grün

## Workflow follow-up

- Change mit `openspec archive snapshot-terminal-modes -y` archivieren und `bash scripts/openspec-check.sh --specs` ausführen.
