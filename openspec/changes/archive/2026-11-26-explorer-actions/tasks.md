# Tasks

## 1. Reine Regeln

- [x] 1.1 Geschützte Orte wie im Main (`renderer/explorer-actions.test.ts`, „isProtectedPath …“)
- [x] 1.2 Menüeinträge je Backend, Typ, Schutz und Schreiber (`renderer/explorer-actions.test.ts`, „explorerMenu …“)
- [x] 1.3 Drop-Ziele: Wurzel und Ordner, nie in sich selbst, darunter oder in den eigenen Ordner (`renderer/explorer-actions.test.ts`, „canDropEntry …“)
- [x] 1.4 Neuer Name und seine Markierung, Lösch-Text, gezählte Ordner, Fehlertexte, übersprungene Einträge (`renderer/explorer-actions.test.ts`, „renameTarget …“, „renameSelection …“, „deleteConfirmation …“, „countsEntries …“, „actionErrorText …“, „skippedText …“)
- [x] 1.5 Baum nach Umbenennen, Verschieben, Löschen und Fehler mit Auswahl und Ladungen (`renderer/explorer-actions.test.ts`, „the tree after an action …“)
- [x] 1.6 Quotierung für POSIX, PowerShell und `cmd`, Steuerzeichen, Shell der Session (`renderer/path-quote.test.ts`)
- [x] 1.7 `F2` und `Entf` im Baum (`renderer/explorer-keys.test.ts`, „renames the selected entry with F2 …“)
- [x] 1.8 Einfügen nur in das gefolgte, schreibende Pane (`renderer/explorer-source.test.ts`, „pastePaneId …“)

## 2. Panel

- [x] 2.1 Kontextmenü, Umbenennen in der Zeile, Lösch-Dialog, Ziehen, Herunterladen, Kopieren und Einfügen in `ExplorerPanel.tsx`, Schreiber aus `App.tsx` (Screenshot-Gruppe `explorer`, Szenen `75a` bis `75e`)

## 3. Screenshots und Doku

- [x] 3.1 Szenen `75a` bis `75e` mit Sichtbarkeitsselektor; sie prüfen Menüeinträge, Fokus nach `Shift+F10`, eingefügten Pfad ohne Enter, Markierung beim Umbenennen, Hinweis bei `EEXIST`, Abbruch des Ziehens mit Escape, Verschieben, Text und Fokus des Lösch-Dialogs (`main/scene-prefixes.test.ts`, Lauf `--scenes explorer`)
- [x] 3.2 ADR 0006 und ADR 0009 nennen die Aktionen; geprüft durch `bash scripts/openspec-check.sh --specs`
