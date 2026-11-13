# Tasks

## 1. WSL-Backend und Registry

- [x] 1.1 Test: `parseSnapshot` hängt Reset, Positionierung und Sichtbarkeit an; `snapshotArgs` fragt `#{cursor_flag}` mit ab (`backend/wsl/commands.test.ts`)
- [x] 1.2 `parseSnapshot` und `snapshotArgs` umgesetzt (`backend/wsl/commands.ts`)
- [x] 1.3 Test: `cursor` bleibt ohne angehängte Ausgabe und entfällt mit ihr (`session/registry.test.ts`)

## 2. WSL

- [x] 2.1 Integrationstest: Cursor per `printf '\e[5;10H'` versetzen, anhängen, Snapshot endet mit `ESC[5;10H` (`TERMDOCK_WSL_TESTS=1`)

## 3. Dokumentation

- [x] 3.1 ADR 0003 präzisieren
