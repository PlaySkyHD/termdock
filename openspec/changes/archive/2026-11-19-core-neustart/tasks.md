# Tasks

## 1. Main

- [x] 1.1 Test und Umsetzung: `CoreSupervisor` mit Neustart nach Ende, Grenze 3 in 2 Minuten, Knopf, `stop`, fremdem Core und stabiler Port (`main/core-supervisor.test.ts`)
- [x] 1.2 Test und Umsetzung: Brücke sendet `coreClosed { restarting }` und `coreRestarted`, nimmt `restartCore` an und vergisst die Views des alten Core (`main/bridge.test.ts`)
- [x] 1.3 Verdrahtung in `main.ts`: Supervisor statt Client, Quit-Flow und Ende des Screenshot-Laufs stoppen ihn
- [x] 1.4 WSL-Integrationstest: Kill des Core, Neustart, Session `Detached`, Snapshot mit alter Ausgabe (`main/core-supervisor.wsl.test.ts`)

## 2. Renderer

- [x] 2.1 Test und Umsetzung: Controller mit Rolle `restarting` und `claimOnOpen` (`renderer/terminal-controller.test.ts`)
- [x] 2.2 Test und Umsetzung: `connectStore` holt nach `coreRestarted` neu, Store erhöht die Generation (`renderer/session-sync.test.ts`, `renderer/ui-store.test.ts`)
- [x] 2.3 Test: nach `coreRestarted` jede View neu angehängt, genau ein Schreiber (`renderer/core-restart.test.ts`)
- [x] 2.4 Pane-Overlay, Knopf „Core neu starten“, Hinweis „Core neu gestartet“ (`PaneTree.tsx`, `TerminalView.tsx`, `App.tsx`, `StatusBar.tsx`, `styles.css`), Texte getestet (`renderer/session-display.test.ts`)

## 3. Screenshots und Dokumentation

- [x] 3.1 Screenshot-Gruppe `restart` (`main/screenshot-restart.ts`, Szenen 90 und 91 mit Sichtbarkeitsselektor; `main/screenshot.test.ts` für die Gruppe)
- [x] 3.2 ADR 0006 um den Neustart ergänzen
