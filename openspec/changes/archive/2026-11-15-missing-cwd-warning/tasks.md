# Tasks

## 1. Vertrag

- [x] 1.1 Test und Umsetzung: `SessionWarning`, `warnings` an `SessionInfo` und `session.stateChanged`, Guards mit Grenzen und unbekannten Codes, `PROTOCOL_VERSION` 1.5 (`packages/protocol/src/guards.test.ts`)

## 2. WSL-Backend

- [x] 2.1 Test und Umsetzung: `checksCwd`, `cwdCheckArgs`, `parseCwdCheck` (`backend/wsl/commands.test.ts`)
- [x] 2.2 Test und Umsetzung: `start` prüft parallel zum Statusaufruf, Warnung bei fehlendem Verzeichnis, keine bei vorhandenem, bei Fehler, Wurf, Zeitüberschreitung, `~`, Beitritt und `attach`; eigener Timeout (`backend/wsl/backend.test.ts`)
- [x] 2.3 Integrationstest gegen WSL: Start in fehlendem Verzeichnis läuft in `/` mit Warnung (`backend/wsl/backend.wsl.test.ts`)

## 3. Registry und Server

- [x] 3.1 Test und Umsetzung: Warnungen in Antwort, Liste und Zustandswechseln, Ende des Laufs, Neustart, Wiederanbinden, nicht gespeichert (`session/registry.test.ts`, „start warnings“)
- [x] 3.2 Test und Umsetzung: `session.stateChanged` und `session.create` über die Pipe, Version 1.5 (`ipc/ipc.test.ts`)

## 4. Desktop

- [x] 4.1 Test und Umsetzung: Brücke reicht `warnings` weiter (`main/bridge.test.ts`), `connectStore` wendet sie an (`renderer/session-sync.test.ts`)
- [x] 4.2 Test und Umsetzung: Store ersetzt Warnungen, merkt geschlossene Hinweise bis `Starting` (`renderer/ui-store.test.ts`), `warningTexts` (`renderer/session-display.test.ts`)
- [x] 4.3 Hinweis im Pane (`PaneTree.tsx`, `styles.css`) und Screenshot-Szene `screenshot-cwd.ts` (prüft Text, `cwd=/`, Schließen, weitere Eingabe)

## 5. Dokumentation

- [x] 5.1 ADR 0002 (Protokoll 1.5) und ADR 0003 (Prüfung des Arbeitsverzeichnisses) ergänzen
