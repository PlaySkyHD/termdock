# Proposal

## Why

Der Core hält die Ausgabe einer Session nur flüchtig (Puffer für den Snapshot, 256 KiB). Konzept Kapitel 8 und ADR 0004 verlangen einen persistenten Verlauf je Session, standardmäßig auf 10 MiB begrenzt und abschaltbar, auch bei hoher Ausgabe. Ohne ihn gibt es weder Suche (P3-7) noch Archiv (Issue #59, Phase 3).

## What Changes

- Neuer `HistoryStore` in `packages/core/src/storage/`: Ringpuffer aus zwei Segmentdateien `history/<sessionId>/a.log` und `b.log` nach ADR 0004 (Eintrag `uint64 BE Zeitstempel ms | uint32 BE Länge | Rohbytes`, Wechsel bei Limit / 2).
- Schreiben blockiert die PTY nie: `append` reiht in eine begrenzte Warteschlange ein (1 MiB je Session), ein Hintergrund-Flush schreibt sie. Bei Rückstau werden die ältesten wartenden Einträge verworfen und gezählt.
- Leser `readHistory`/`HistoryStore.read`: Einträge von alt nach neu, ein abgeschnittener oder beschädigter letzter Eintrag eines Segments wird übersprungen (für die Suche, P3-7).
- `recordHistory` hängt den Store über `SessionRegistry.onOutput` an die Ausgabe; `SessionInfo.loggingEnabled` entscheidet je Ausgabe. Abschalten stoppt das Schreiben, vorhandene Daten bleiben.
- Einstellungen werden als Funktion `getSettings` eingespeist (`historyLimitBytes`, `historyEnabledByDefault`); der Core-Start verdrahtet vorerst `DEFAULT_SETTINGS` (das Settings-Repository folgt mit #60). `SessionRegistryOptions.defaultLoggingEnabled` liefert den Standard für neue Sessions ohne Angabe.
- Pfadfunktion `historyDir(dataDir, sessionId)` für das Löschen (#57).

## Capabilities

### New Capabilities

- `history`: Persistenter Verlauf je Session als Ringpuffer (Format, Limit, nicht blockierendes Schreiben, Leser, Logging je Session).

### Modified Capabilities

(keine)

## Impact

- `packages/core`: `storage/history-store.ts`, `storage/history-recorder.ts`, `bin/run-core.ts`, `session/registry.ts` (nur die Option `defaultLoggingEnabled`), `index.ts`; Tests unter `storage/`, `bin/` und der WSL-Test `e2e.wsl.test.ts`.
- Dependencies: keine neuen. Non-Goals: Einstellungen lesen und ändern (#60), Löschen des Verlaufs (#57), Suche (#62), `loggingEnabled` ändern (#57), Desktop und Protokoll.
- Security: Die Pfadfunktion lehnt Session-IDs mit anderen Zeichen als `[A-Za-z0-9_-]` ab, damit kein Pfad das Verzeichnis `history/` verlässt. Der Verlauf enthält Rohbytes der Ausgabe und liegt im Datenverzeichnis des Benutzers; Escape-Sequenzen werden nur gespeichert, nie interpretiert.
- Breaking Changes: keine.
