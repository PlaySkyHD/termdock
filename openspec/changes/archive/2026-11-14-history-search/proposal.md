# Proposal

## Why

Der Verlauf (#59) liegt auf der Platte, aber niemand kann ihn durchsuchen. Konzept Kapitel 8 und Phase 3 (P3-7) verlangen eine Suche über den gespeicherten Verlauf aller Sessions. `history.search` ist seit Protokoll 1.3 (#55) nur ein Platzhalter, der `internal` meldet.

## What Changes

- **Core:** `history.search { query, sessionIds?, limit? }` ersetzt den Platzhalter. Die Suche liest den Verlauf über `HistoryStore.read` (Lese-Lock gegen Rotation), entfernt Escape-Sequenzen erst beim Lesen, vergleicht Klartext ohne Beachtung der Groß- und Kleinschreibung und liefert je Zeile höchstens einen Treffer mit Session, Zeitstempel, Zeile und Position. Die neuesten Treffer kommen zuerst.
- Grenzen: Treffer (`limit`, höchstens 200), Zeichen je Trefferzeile (512), Zeilenpuffer beim Lesen (4096 Zeichen), Laufzeit (5 s, danach Teilergebnis mit `truncated: true`).
- Durchsucht werden Sessions mit Verlauf, auch archivierte; Sessions mit abgeschaltetem Logging haben keinen Verlauf und fehlen, gelöschte Sessions und Verläufe ohne Session werden übersprungen.
- **Desktop:** Suchdialog mit `Ctrl+Shift+F` (Befehl `searchHistory`) und Schaltfläche in der Tab-Leiste. Treffer gruppiert nach Session mit Name, Zeit und Zeilenausschnitt, Treffer hervorgehoben. Klick öffnet oder fokussiert die Session (archivierte und beendete als Platzhalter). Brücke: neuer Aufruf `searchHistory`.
- Screenshot-Szenen mit Treffern aus zwei Sessions.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `core-ipc`: Der Platzhalter für `history.search` entfällt; alle Methoden der Phase 3 sind umgesetzt.
- `history`: Suche über den Verlauf.
- `desktop-shell`: Suchdialog, Kürzel, Screenshot-Szene.

## Impact

- `packages/core`: neu `storage/history-search.ts`, `HistoryStore.listSessions`, `ipc/server.ts` (Option `searchHistory`), `bin/run-core.ts`. `apps/desktop`: `shared/bridge.ts`, `main/bridge.ts`, Preload, Renderer (`history-search.ts`, `SearchDialog.tsx`, `keymap.ts`, `commands.ts`, `App.tsx`, `TabBar.tsx`), Szene `main/screenshot-search.ts`.
- IPC und Protokoll unverändert (Vertrag seit 1.3, `PROTOCOL_VERSION` bleibt). ADR 0004 nennt die Suche bereits.
- Non-Goals: Suche mit regulären Ausdrücken, Suche in der Ausgabe einer laufenden Ansicht, Anzeige des Treffers im Platzhalter einer archivierten Session, Einschränkung des Dialogs auf einzelne Sessions (das Protokoll kann es: `sessionIds`).
- Security: Terminal-Ausgabe ist Daten. Escape-Sequenzen werden nur entfernt, nie interpretiert; der Renderer zeigt Trefferzeilen als Text. Suchtext wird als Text, nicht als Muster verwendet. Session-IDs werden vor dem Pfadbau geprüft (`historyDir`).
- Breaking Changes: keine. Dependencies: keine neuen.
