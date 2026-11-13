# Proposal

## Why

Das Gerüst aus #24 zeigt genau eine Session pro Fenster. Phase 2 (Kapitel 12, „Desktop-Erlebnis“) braucht eine Oberfläche, mit der Benutzer mehrere langlebige Sessions überblicken und wechseln: eine Sidebar mit dem Zustand jeder Session, Tabs und eine Statusleiste (Issue #26). Splits (#27), Tastenkürzel (#28) und die Layout-Wiederherstellung (#29) bauen auf einem UI-Zustand auf, der ihnen schon in der Form von `LayoutWindow`/`LayoutTab` (#25) entspricht.

## What Changes

- **Sidebar:** Sessions gruppiert nach `workspaceId` (Überschrift ist die ID, Workspace-Namen folgen mit Phase 3) und immer ein Bereich „Ohne Gruppe“. Jede Session zeigt ein Zustandssymbol für `Starting`, `Running`, `Detached`, `Exited`, `Interrupted`; sie aktualisiert sich über `session.stateChanged`. Aktion „Neue WSL-Session“ (Name, Arbeitsverzeichnis, Standard `~`). Klick öffnet die Session als Tab oder fokussiert den vorhandenen Tab. Ein- und ausblendbar.
- **Tabs:** öffnen, wechseln, schließen. Schließen löst die View (`session.detach`), die Session läuft weiter. Jeder Tab ist eine eigene View, auch für dieselbe Session in einem anderen Tab oder Fenster (Strg+Klick).
- **Fenster:** Menü „Neues Fenster“; jedes Fenster hat eigene Tabs. Ein Fenster ohne Tabs zeigt die Sidebar und einen Leerzustand. Die automatische Wahl einer Session beim Start entfällt.
- **Statusleiste:** Backend und Distro der aktiven Session, Session und ihr Zustand, Rolle der View (Schreiber, Leser) mit „Schreibrecht übernehmen“, Hinweis bei `backendUnavailable`.
- **UI-Store** (`ui-store.ts`): reiner Code ohne React und Electron, in der Form von `LayoutWindow` mit `LayoutTab`; jeder Tab hat in diesem Change genau ein Pane.
- **Brücke:** neuer Aufruf `coreStatus` (`core.status`), neues Event `sessionCreated` an alle Fenster, damit jede Sidebar eine neue Session sieht (der Core hat kein Event dafür).
- **Screenshot-Modus:** Szenario mit mehreren Sessions in verschiedenen Zuständen, mehreren Tabs, eingeklappter Sidebar, leerem Fenster und Leser.
- ADR 0006 ergänzt (Tabs bleiben angehängt, Sidebar, `sessionCreated`).

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: ADDED Sidebar, Zustandsdarstellung, Tabs, Fenster mit eigenen Tabs, Statusleiste, UI-Store; MODIFIED Brücke (Aufrufliste), Events (`sessionCreated`), Start der View (kein Auto-Tab), Screenshot-Modus.

## Impact

- Geändert: `apps/desktop/**` (Brücke, Preload, Main-Menü, Renderer, Screenshot-Ablauf), `docs/adr/0006-desktop-architektur.md`.
- IPC-Methoden: keine neuen im Protokoll; neu genutzt wird `core.status` im Renderer-Pfad. Datenmodelle unverändert; `LayoutWindow`, `LayoutTab` und `LayoutPane` werden nur als Typen benutzt.
- Dependencies: keine neuen.
- Non-Goals: Workspaces anlegen und zuordnen (Phase 3), Splits (#27), Tastenkürzel (#28), Speichern und Wiederherstellen des Layouts (#29), Tabs umsortieren oder zwischen Fenstern ziehen, Sessions löschen oder beenden, Wiederverbinden nach Core-Absturz.
- Security: Der Renderer bekommt nur einen weiteren lesenden Aufruf (`coreStatus`) mit Laufzeitprüfung im Main; sonst unverändert (CSP, `sandbox`, `contextIsolation`). Der Screenshot-Modus ruft `wsl.exe` nur mit festem Argument-Array gegen den Socket `termdock-test` auf.
- Breaking Changes: Ein neues Fenster zeigt ohne Eingriff keine Session mehr; der Benutzer wählt sie in der Sidebar.
