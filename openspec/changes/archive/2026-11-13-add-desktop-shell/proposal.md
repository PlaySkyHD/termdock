# Proposal

## Why

Phase 1 hat den Core fertig zusammengesetzt (Pipe, Registry, Storage, WSL-Backend, Client-Bibliothek), aber es gibt noch keine Oberfläche: Sessions sind nur über Tests und Skripte erreichbar. Phase 2 (Kapitel 12, „Desktop-Erlebnis“) beginnt mit einem Gerüst der Desktop-App, das sich an den echten Core anbindet und eine WSL-Session in xterm.js zeigt. Sidebar, Tabs, Splits, Tastenkürzel und Layout-Wiederherstellung (#26 bis #29) bauen auf diesem Gerüst auf (Issue #24).

## What Changes

- Neues Workspace-Paket `apps/desktop` (Electron 45.3.1, React, TypeScript, Renderer mit Vite gebaut, eigenes CSS im Stil von VS Code, keine UI-Bibliothek). `apps/*` kommt in die npm-Workspaces und in die Projekt-Referenzen von `tsconfig.json`; Typecheck, Lint, Format und Tests decken das Paket auch in der CI ab.
- Electron-Main: ein Prozess für alle Fenster (`requestSingleInstanceLock`), ein zweiter Start öffnet ein weiteres Fenster im laufenden Main.
- Core-Anbindung im Main (ADR 0001): zuerst verbinden; scheitert das, den Core als losgelösten Kindprozess starten (`process.execPath` mit `ELECTRON_RUN_AS_NODE=1`, `detached`) und mit Backoff bis 5 s Gesamtzeit erneut verbinden. Die erste Anfrage nach `hello` wartet mit großzügigem Timeout auf das Ende des Abgleichs.
- Typisierte, schmale Brücke Renderer ↔ Main (ADR 0002): feste Liste erlaubter Aufrufe, Prüfung der Argumente im Main, Views gehören dem Fenster, das sie angelegt hat. `contextIsolation`, `sandbox`, kein `nodeIntegration`, CSP ohne Inline-Skripte.
- Terminal-View (aus `poc/` übernommen): xterm.js mit Fit-Addon, Start über `session.list` oder Anlegen einer WSL-Session in `~`, `session.attach` mit Snapshot, Ein- und Ausgabe, Größe über den Schreiber, lesende Views verwerfen automatische Antworten, „Schreibrecht übernehmen“ per Klick.
- Screenshot-Modus `--screenshot <dir>` gegen einen isolierten Core (eigene Pipe, Temp-Datenverzeichnis, tmux-Socket `termdock-test`), der seine Sessions danach beendet.
- `packages/core/src/bin/termdock-core.ts` liest `TERMDOCK_PIPE` und `TERMDOCK_TMUX_SOCKET` und gibt sie an `runCore` weiter (sonst keine Änderung am Core).
- Neues ADR 0006 „Desktop-Architektur“.

## Capabilities

### New Capabilities

- `desktop-shell`: Desktop-App als Client des Core: Prozessaufteilung und Einzelinstanz, Verbinden oder Starten des Core, Brücke zwischen Renderer und Main, Terminal-View mit Schreiber und Lesern, Screenshot-Modus.

### Modified Capabilities

(keine; `core-ipc` beschreibt Pipe-Name und tmux-Socket als Optionen, die neuen Umgebungsvariablen ändern keine Anforderung)

## Impact

- Neu: `apps/desktop/**`, `docs/adr/0006-desktop-architektur.md`.
- Geändert: `package.json` (Workspaces), `tsconfig.json` (Referenzen), `package-lock.json`, `packages/core/src/bin/termdock-core.ts`, `.agents/instructions/typescript.instructions.md` (Abhängigkeitsrichtung für den Desktop-Main).
- IPC-Methoden: keine neuen. Genutzt werden `hello`, `core.status`, `session.list`, `session.create`, `session.attach`, `session.detach`, `session.input`, `session.resize`, `session.claimWriter`, im Screenshot-Modus `core.shutdown { stopSessions: true }`. Datenmodelle unverändert.
- Dependencies (Begründung in `design.md`): `electron` 45.3.1, `react`, `react-dom`, `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, `vite`, `@types/react`, `@types/react-dom`.
- Parallel: Issue #25 ändert `packages/protocol` und `packages/core` (Layout-Persistenz); dieser Change berührt dort nur `termdock-core.ts`.
- Non-Goals: Sidebar, Tabs, Splits, Layout und seine Wiederherstellung, Tastenkürzel, Wiederverbinden nach Core-Absturz, Windows-Backend in der UI, Installer.
- Security: Der Renderer erreicht die Pipe nicht; der Main lässt nur die Aufrufe der Brücke zu und nur für Views des aufrufenden Fensters. Keine Netzwerkzugriffe, keine Inline-Skripte. Der Screenshot-Modus berührt den Produktiv-Socket `termdock` nicht.
- Breaking Changes: keine.
