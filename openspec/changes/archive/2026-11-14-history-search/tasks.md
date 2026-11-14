# Tasks

## 1. Core

- [x] 1.1 Test und Umsetzung: `AnsiStripper` entfernt CSI, OSC, DCS und Zwei-Zeichen-Escapes auch über Eintragsgrenzen und lässt unbeendete Sequenzen nicht den Rest verschlucken (`history-search.test.ts`)
- [x] 1.2 Test und Umsetzung: Suche ohne Beachtung der Groß- und Kleinschreibung, Suchtext als Text, Treffer über Eintragsgrenzen, Zeilenausschnitt, Zeilen über dem Puffer (`history-search.test.ts`)
- [x] 1.3 Test und Umsetzung: Grenzen `limit`, 200 Treffer, Laufzeit mit `truncated` (`history-search.test.ts`)
- [x] 1.4 Test und Umsetzung: Treffer über zwei Segmente nach Rotation, Rotation und Ausgabe während der Suche, gelöschte Session, Session ohne Verlauf, noch nicht geschriebene Ausgabe (`history-search.test.ts`, `HistoryStore.listSessions`)
- [x] 1.5 Test und Umsetzung: `history.search` im Core-IPC, nur der Registry bekannte Sessions, Logging aus und gelöscht ohne Treffer, Fehler als `internal` (`ipc.test.ts`, `run-core.test.ts`)

## 2. Desktop

- [x] 2.1 Test und Umsetzung: Brücke `searchHistory` ohne Session-IDs, Prüfung von Suchtext und Limit (`bridge.test.ts`)
- [x] 2.2 Test und Umsetzung: Suchmodell mit Pause, neuester Antwort, Gruppierung, Fehlern und Abbau (`history-search.test.ts` im Renderer)
- [x] 2.3 Test und Umsetzung: Kürzel `Ctrl+Shift+F` und Befehl `searchHistory`, modal gegenüber den anderen Befehlen (`keymap.test.ts`, `commands.test.ts`)
- [x] 2.4 Suchdialog und Schaltfläche; Screenshot-Szene mit Treffern aus zwei Sessions (Prüfung: `npm run screenshot -w apps/desktop -- <dir>`, Bilder `26-…` bis `28-…`)

## 3. Spezifikation

- [x] 3.1 Platzhalter-Anforderung in `core-ipc` entfernt (REMOVED, keine Platzhalter mehr) und durch `history.search` ersetzt, Anforderungen in `history` und `desktop-shell` (Prüfung: `bash scripts/openspec-check.sh --specs`)
