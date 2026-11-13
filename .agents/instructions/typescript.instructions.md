---
description: 'Konventionen für TypeScript-Code und Tests in TermDock.'
applyTo: '**/*.ts,**/*.tsx'
paths:
  - "packages/**/*.ts"
  - "packages/**/*.tsx"
  - "apps/**/*.ts"
  - "apps/**/*.tsx"
---

# TypeScript

Stack: Node 22+ (lokal 25), TypeScript strict, npm Workspaces, Vitest, ESLint, Prettier. Electron, React und xterm.js erst in `apps/desktop`. Keine weiteren Dependencies ohne Begründung im OpenSpec-Design.

## Pakete

- `packages/protocol`: Domänentypen und IPC-Vertrag (ADR 0002). Keine Laufzeit-Abhängigkeit auf andere Pakete, kein Node-API außer `Buffer`-freien Typen.
- `packages/core`: Session Registry, Lifecycle, Eingabe-Lock, Backends, Storage, IPC-Server. Kennt weder Electron noch React.
- `apps/desktop`: Electron-Main, Preload, Renderer (ADR 0006). Spricht mit dem Core nur über die Pipe mit dem Vertrag aus `packages/protocol`.
- Abhängigkeiten nur in diese Richtung: `desktop → protocol`, `core → protocol`, dazu der Desktop-Main → `core` nur für die Client-Bibliothek (`connect`, `defaultPipeName`, `IpcError`) und den Pfad des Core-Einstiegs. Renderer und Preload importieren nur Typen. Nie `protocol → core` oder `core → desktop`.

## Code

- `strict`, kein `any` ohne Kommentar mit Grund. Zustände als String-Literal-Unions, nicht als Zahlen-Enums.
- Fehler, die über IPC gehen, haben einen stabilen `code` (ADR 0002).
- Prozesse und Pipes immer mit Timeout und sauberem Abbau (`dispose()`), keine hängenden Handles in Tests.
- Pfade: Windows-Pfade für Core-Daten, Linux-Pfade nur innerhalb des WSL-Backends. Umrechnung nur an einer Stelle (`wslPath`).

## Prüfen

- `npm run typecheck`, `npm run lint`, `npm run format:check` im Repo-Root.
- Tests nur für betroffene Pakete: `npm test -w packages/<name>`.
- WSL-Integrationstests laufen nur mit `TERMDOCK_WSL_TESTS=1` (brauchen Ubuntu mit tmux, lokal vorhanden, nicht in der CI).

## Tests

- Vitest, Tests neben dem Code unter `src/**/*.test.ts`.
- Verhalten über die öffentliche Schnittstelle des Pakets testen (Skill `tdd`). Backends über `FakeBackend` ersetzen, nicht interne Klassen mocken.
- Jeder Test räumt tmux-Sessions (Socket `-L termdock-test`), Pipes und Temp-Verzeichnisse selbst auf.
