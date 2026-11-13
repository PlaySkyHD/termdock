# Design

## Context

ADR 0004 nennt die Tabelle `layouts` (Migration 1: `id`, `workspace_id`, `data`, `updated_at`). Der Core hält ein globales Layout für alle Fenster; ein einziger Electron-Main speichert das ganze Dokument. Ein Event `layout.changed` ist deshalb nicht nötig.

## Goals / Non-Goals

**Goals:** Typen und Prüfung im Protokollpaket, damit Core und Desktop dasselbe Dokument kennen; Layout übersteht einen Core-Neustart; Schutz vor überschriebenen Ständen durch eine Revision.

**Non-Goals:** Layout je Workspace, Events, Verhalten der Desktop-App, Prüfung, ob eine `sessionId` existiert.

## Decisions

### Dokumentform

`LayoutDocument { version: 1, windows[] }`. Ein Fenster hat `id`, optional `bounds`, `maximized`, `sidebarVisible`, `sidebarWidth`, `tabs[]` (0 bis 64; ein Fenster ohne Tabs zeigt nur Sidebar und Leerzustand) und `activeTabId` (Pflicht bei vorhandenen Tabs, bei leerem `tabs` weggelassen). Ein Tab hat `id`, `title?`, `root` und `activePaneId`. `PaneNode` ist ein Blatt `{ kind: "pane", id, sessionId }` oder ein Split `{ kind: "split", id, direction, children, sizes }`. `windows` darf leer sein (alle Fenster geschlossen). `LAYOUT_VERSION` und `MAX_PANES_PER_TAB` (4) stehen in `model.ts`.

### Prüfung

`validateLayoutDocument(value)` liefert `ParseResult<LayoutDocument>` (Fehler `bad_request` mit lesbarer Meldung). Geprüft werden: Version, IDs eindeutig im ganzen Dokument (Fenster, Tabs, Panes, Splits), höchstens 4 Blätter je Tab (Abbruch schon beim Zählen, damit tiefe Verschachtelung nichts kostet), Split mit mindestens 2 Kindern, `sizes` gleich lang wie `children`, jeder Wert endlich und größer 0, Summe 1 ± 0,01, `activeTabId` verweist auf einen Tab des Fensters, `activePaneId` auf ein Blatt im Baum des Tabs. Damit ein gespeichertes Dokument samt Antwort unter dem Header-Limit von 1 MiB bleibt, gelten Obergrenzen: 16 Fenster, 64 Tabs je Fenster, 128 Zeichen je Tab-Titel, 64 Zeichen je ID und `sessionId` sowie ein Byte-Budget von 256 KiB für das UTF-8 von `JSON.stringify` (`MAX_LAYOUT_WINDOWS`, `MAX_TABS_PER_WINDOW`, `MAX_TAB_TITLE_LENGTH`, `MAX_LAYOUT_ID_LENGTH`, `MAX_LAYOUT_BYTES`). Unbekannte Schlüssel werden abgelehnt, damit nichts Fremdes mitgespeichert wird. Beim Lesen aus SQLite wird das Dokument erneut geprüft; ein unbrauchbares Dokument ergibt `{ revision }` ohne `layout` und eine Meldung auf stderr (der Client prüft das Ergebnis von `layout.get` voll und würde sonst jedes `layout.get` verwerfen). `sessionId` wird nur auf Form geprüft, nicht auf Existenz (die App zeigt einen Platzhalter). `layout.save` prüft über denselben Weg; die Antwort von `layout.get` wird ebenfalls geprüft.

### Revision

`revision` ist 0, solange nichts gespeichert ist, und steigt mit jedem Speichern um 1. `layout.save` ohne `baseRevision` überschreibt immer; mit `baseRevision` ungleich der aktuellen Revision antwortet der Core `invalid_state`. Die Spalte kommt als **Migration 2** (`ALTER TABLE layouts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`), Migration 1 bleibt unverändert. Das globale Layout ist die Zeile mit `id = 'global'` und `workspace_id` NULL.

### Repository

`LayoutRepository { get(): { layout?, revision }; save(layout, baseRevision?): number }`, synchron wie `SessionRepository`. Der Revisionskonflikt wird als `CoreError("invalid_state")` geworfen. SQLite-Variante: Lesen, Prüfen und Schreiben in einer `BEGIN IMMEDIATE`-Transaktion. Der Server nimmt das Repository optional (Standard: In-Memory); `runCore` reicht es wie das Session-Repository über einen Weiterleiter durch, weil die Datenbank erst nach dem Belegen der Pipe geöffnet wird.

## Risks / Trade-offs

- Gespeichertes JSON wird beim Lesen nicht erneut geprüft (wie bei Sessions); ein beschädigter Eintrag führt zu `internal`.
- Die Obergrenze von 1 MiB je Header begrenzt die Dokumentgröße.
