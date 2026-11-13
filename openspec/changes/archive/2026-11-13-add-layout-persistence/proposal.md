# Proposal

## Why

Die Desktop-App soll nach einem Neustart Fenster, Tabs und Split-Panes vollständig wiederherstellen (Konzept Phase 2, Abnahme 08). Dafür muss der Core das Layout speichern und ausliefern (ADR 0004, Tabelle `layouts`). Die Desktop-Issues #26 bis #29 bauen auf diesen Typen und Methoden auf.

## What Changes

- Neue gemeinsame Typen in `packages/protocol/src/model.ts`: `LayoutDocument` (mit Versionsfeld), `LayoutWindow`, `LayoutTab`, `PaneNode` (`LayoutPane` oder `LayoutSplit`), `WindowBounds`.
- Neue Prüffunktion `validateLayoutDocument` in `guards.ts`: eindeutige IDs, höchstens 4 Panes je Tab, aktive IDs vorhanden, gültige `sizes`. Eine unbekannte `sessionId` ist kein Fehler.
- Neue Methoden `layout.get` (liefert `layout?` und `revision`) und `layout.save` (`layout`, optional `baseRevision`; liefert `revision`). Ein veraltetes `baseRevision` ergibt `invalid_state`.
- Neues `LayoutRepository` im Core (SQLite und In-Memory), ein globales Layout in der Tabelle `layouts`. Migration 2 ergänzt die Spalte `revision`.
- `CoreServer` und `runCore` verdrahten das Repository; `layout.*` wartet wie andere Anfragen auf den Abgleich beim Start.
- ADR 0002 (Methodenliste) und ADR 0004 (Tabelle `layouts`, Revision) werden nachgezogen.
- Keine Breaking Changes: neue Methoden und Typen, `layouts` im Server ist optional.

## Capabilities

### New Capabilities

- `layout-persistence`: Form und Prüfung des Layout-Dokuments, Ablage mit Revision im Core, Methoden `layout.get` und `layout.save`.

### Modified Capabilities

- `ipc-protocol`: Die Methodenliste enthält `layout.get` und `layout.save` mit typisierten Parametern und Ergebnissen.

## Impact

- `packages/protocol` (`model.ts`, `messages.ts`, `guards.ts`), `packages/core` (`storage/`, `ipc/server.ts`, `bin/run-core.ts`, `index.ts`), ADR 0002 und 0004.
- Nicht betroffen: `apps/**`, `packages/core/src/bin/termdock-core.ts`, WSL-Backend, Registry.
