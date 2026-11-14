# Proposal

## Why

Der Core kennt seit #56 und #57 Workspaces, Projekte und die Session-Verwaltung (`session.update`, `session.archive`, `session.delete`), die Sidebar zeigt aber noch Workspaces nur als ID-Überschrift, kann nichts verschieben und kennt kein Archiv (Konzept Kap. 3, Abnahme 01 und 12). Sessions sollen sich ordnen lassen, ohne dass ein Prozess angefasst wird; Archivieren und Löschen brauchen eine Bestätigung, weil sie Prozess und Verlauf beenden.

## What Changes

- Brücke Main und Renderer: Aufrufe `listWorkspaces`, `createWorkspace`, `updateWorkspace`, `deleteWorkspace`, `createProject`, `updateProject`, `deleteProject`, `updateSession`, `archiveSession`, `deleteSession` (geprüft im Main) und die Events `workspaceChanged`, `sessionUpdated`, `sessionRemoved` an alle Fenster.
- Store: Workspaces mit Projekten, `sessionUpdated` (nur Metadaten, nie ein älterer Zustand) und `sessionRemoved`.
- Sidebar: Workspaces mit Namen, Projekten und Sessions, Bereich „Ohne Gruppe“, eingeklapptes Archiv mit „Löschen“, Anlegen, Umbenennen und Löschen von Workspaces und Projekten in einem kleinen Dialog, Bestätigung für Löschen und Archivieren.
- Drag&Drop mit Zeigerereignissen in einem eigenen Modul (`renderer/drag/`): reine Zustandsmaschine und Zielregeln, DOM-Anbindung getrennt, Hervorhebung gültiger Ziele, Esc bricht ab. Es trägt später auch Tabs und Panes (#67).
- Kontextmenü mit denselben Aktionen als Tastatur-Alternative (Menütaste, Umschalt+F10).
- Offene Tabs einer gelöschten Session zeigen den vorhandenen Platzhalter.
- Screenshot-Szenen der Sidebar mit Drag&Drop über `webContents.sendInputEvent`.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: „Schmale Brücke zwischen Renderer und Main“ und „Sidebar mit Sessions nach Workspace“ geändert; neue Anforderungen für Workspace-Verwaltung, Drag&Drop, Archiv, Kontextmenü, Bestätigungen, Events anderer Clients, gelöschte Session im Tab und Screenshot-Szenen.

## Impact

- Paket `apps/desktop` (`shared/bridge.ts`, `main/bridge.ts`, `preload`, Renderer, Screenshot-Szenen), ADR 0006.
- Kein Vertragswechsel: `packages/protocol` und `packages/core` bleiben unverändert.
- Non-Goals: Ziehen von Tabs und Panes (#67), Startprofile (#62), Einstellungen, Sortieren der Workspaces, Verschieben von Projekten.
- Security: Der Main prüft jedes Argument der neuen Aufrufe zur Laufzeit; der Renderer erreicht nur die feste Liste. Namen und Pfade gelangen als Daten in React-Text, nie als HTML oder Shell-String.
- Breaking Changes: keine.
