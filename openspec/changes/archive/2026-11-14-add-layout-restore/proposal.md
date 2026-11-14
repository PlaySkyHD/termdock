# Proposal

## Why

Die Desktop-App verliert beim Neustart der Oberfläche alles: Fenster, Tabs, Splits und Sidebar. Der Core speichert seit #25 ein globales Layout (`layout.get`, `layout.save`), die App nutzt es noch nicht. Abnahme 08 (Layout nach UI-Neustart vollständig wiederhergestellt) und Abnahme 09 (verlorene Prozesse nie als `Running`) verlangen es (Issue #29, Phase 2 aus Kapitel 12).

## What Changes

- Der Main bündelt das Layout aller Fenster zu einem `LayoutDocument` und speichert es mit kurzer Verzögerung und beim Beenden über `layout.save`; Revisionskonflikte (`invalid_state`) lösen `layout.get` und ein erneutes Speichern aus, der letzte Stand gewinnt.
- Jedes Fenster meldet seinen Teil (Tabs, aktiver Tab, Sidebar) über zwei neue Brücken-Aufrufe (`windowLayout`, `reportLayout`); Position, Größe und Maximierung liest der Main selbst aus dem `BrowserWindow`.
- Beim Start liest der Main `layout.get`, öffnet die Fenster mit Position und Größe (geprüft gegen `screen.getAllDisplays()`), und jedes Pane hängt sich neu an (`session.attach` mit Snapshot). Ohne gespeichertes Layout öffnet ein Fenster im Startzustand.
- Ein Pane mit einer Session in `Exited`, `Interrupted`, `Starting`, `Archived` oder ohne Session im Core wird zum Platzhalter mit Zustand, letztem Exit-Code und der Aktion „Pane schließen“, nie als `Running`.
- Der Screenshot-Modus nimmt ein Layout mit 2 Fenstern, mehreren Tabs und Splits vor dem Neustart der Oberfläche und danach auf, dazu den Platzhalter einer `Interrupted`-Session.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: Anforderung „Schmale Brücke“ (zwei neue Aufrufe); neue Anforderungen für Speichern, Wiederherstellen, Fenster-Geometrie, Platzhalter und Screenshot-Szenen.

## Impact

- `apps/desktop`: neu `src/shared/layout-mapping.ts`, `src/main/layout-coordinator.ts`, `src/main/window-geometry.ts`, `src/renderer/pane-placeholder.ts`, `src/renderer/layout-sync.ts`; geändert `ui-store.ts`, `session-sync.ts`, `PaneTree.tsx`, `App.tsx` (klein), `bridge.ts`, `main.ts`, Preload, Screenshot-Szenen. ADR 0006 wird ergänzt.
- Dependencies: keine neuen. Non-Goals: Protokoll und Core (unverändert), Neustarten beendeter Sessions (Phase 3), Tastenkürzel (#28), Sidebar-Breite.
- Security: Der Main prüft jeden Teil, den ein Renderer meldet, mit `validateLayoutDocument` im Gesamtdokument (Grenzen, eindeutige IDs); Position und Größe kommen nie vom Renderer.
- Breaking Changes: keine.
