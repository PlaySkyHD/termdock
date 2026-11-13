# Tasks

## 1. Gerüst

- [x] 1.1 `apps/desktop` mit `package.json`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.renderer.json`, `vite.config.ts`, `vitest.config.ts` anlegen, `apps/*` in Workspaces und Root-`tsconfig.json` aufnehmen; prüfen mit `npm ci`, `npm run typecheck`, `npm run lint`
- [x] 1.2 `termdock-core.ts` liest `TERMDOCK_PIPE` und `TERMDOCK_TMUX_SOCKET`; prüfen mit `npm run typecheck` und manuellem Start gegen eine eigene Pipe im Screenshot-Lauf (6.1)

## 2. Core-Anbindung im Main

- [x] 2.1 `connectOrStartCore`: Verbinden ohne Start, Start und Verbinden mit Backoff, Abbruch nach 5 s, Startfehler, erste Anfrage `core.status` mit großzügigem Timeout; Tests in `core-connection.test.ts` mit Fakes und gesteuerter Uhr
- [x] 2.2 Timeout-Hülle für spätere Anfragen (10 s, Code `timeout`); Test in `core-connection.test.ts`
- [x] 2.3 Losgelöster Start des Core-Einstiegs (`ELECTRON_RUN_AS_NODE=1`, `detached`) und Pfad über die Paketauflösung von `@termdock/core`; Test der Startparameter mit gefälschtem `spawn`

## 3. Brücke

- [x] 3.1 `DesktopBridge`: feste Aufrufliste, Argumentprüfung, Fehlercodes; Tests in `bridge.test.ts`
- [x] 3.2 Views je Fenster (fremde View `not_found`, Fenster schließt → `session.detach`); Tests in `bridge.test.ts`
- [x] 3.3 Events nur an beteiligte Fenster, auch während des Anhängens; Zustandswechsel an alle; Tests in `bridge.test.ts`
- [x] 3.4 Preload mit `contextBridge` und Electron-Verdrahtung in `main.ts` (Einzelinstanz, zweites Fenster, `sandbox`, CSP); prüfen im Screenshot-Lauf (6.1, gleiche Verdrahtung mit isoliertem Core)

## 4. Terminal-View

- [x] 4.1 `pickOrCreateSession`: erste lebende Session oder neue WSL-Session in `~`; Tests in `start-session.test.ts`
- [x] 4.2 `TerminalController`: Snapshot vor Live-Ausgabe, Schreiber sendet Eingabe und Größe, Leser verwirft Eingabe und übernimmt Schreibergröße, Schreibrecht übernehmen, `dispose` löst die View; Tests in `terminal-controller.test.ts`
- [x] 4.3 `TerminalView.tsx`, `App.tsx`, Statusleiste und CSS im Stil von VS Code; prüfen an den PNGs des Screenshot-Laufs (6.1)

## 5. Dokumentation

- [x] 5.1 ADR 0006 „Desktop-Architektur“ schreiben, Abhängigkeitsregel in `.agents/instructions/typescript.instructions.md` präzisieren; prüfen mit `npm run format:check`

## 6. Screenshot-Modus und Abschluss

- [x] 6.1 `--screenshot <dir>` gegen isolierten Core (eigene Pipe, Temp-Datenverzeichnis, Socket `termdock-test`, Sessions danach beendet); Argument und Umgebung getestet in `screenshot.test.ts`, Lauf mit WSL erzeugt PNG mit Prompt und `ls --color`, danach `tmux -L termdock-test ls` ohne Session dieses Laufs
- [x] 6.2 `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test -w apps/desktop`, `npm test -w packages/core` grün

## Workflow follow-up

- Change mit `bash scripts/openspec-check.sh add-desktop-shell` prüfen, archivieren und `bash scripts/openspec-check.sh --specs` ausführen.
