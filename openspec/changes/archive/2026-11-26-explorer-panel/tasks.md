# Tasks

## 1. Protokoll und Layout

- [x] 1.1 `LayoutWindow.explorerVisible`, `explorerWidth`, Guards, Version 1.9 (`packages/protocol/src/layout.test.ts`, „accepts a full document …“, „rejects invalid window fields“; `guards.test.ts`, „speaks protocol 1.9 …“)
- [x] 1.2 Core speichert und liefert die Felder unverändert, antwortet 1.9 (`packages/core/src/ipc/ipc.test.ts`, „keeps the explorer panel of a window …“, „accepts clients with protocol 1.2 to 1.8 and answers 1.9 …“)
- [x] 1.3 Main nimmt die Felder in `reportLayout` an und speichert ohne sie, wenn ein älterer Core ablehnt (`main/bridge.test.ts`, „takes the explorer panel of the window …“; `main/layout-coordinator.test.ts`, „saves without the explorer fields …“, „does not retry a refused layout …“; `renderer/layout-mapping.test.ts`, „passes the explorer panel of a window through …“)

## 2. Reine Modelle im Renderer

- [x] 2.1 Baum: Laden bei Bedarf, Zeilen, Fehler/Leer/Abgeschnitten, veraltete Antworten, neuer Baum, Aktualisieren, Schnittstellen für #203 (`renderer/explorer-tree.test.ts`)
- [x] 2.2 Wahl der Session und des Orts, Standard-Distro, Schlüssel, gekürzter Pfad (`renderer/explorer-source.test.ts`)
- [x] 2.3 Tasten, Klick und Doppelklick (`renderer/explorer-keys.test.ts`)
- [x] 2.4 Breite, Sichtbarkeit im Store, Texte, `panelView` (`renderer/explorer-view.test.ts`)
- [x] 2.5 Windows-Verzeichnis in den Store (`renderer/session-cwd.test.ts`, „relayCwd …“)

## 3. Kürzel, Befehle, Menü

- [x] 3.1 `toggleExplorer` (`Ctrl+Shift+X`), `focusExplorer` (`Ctrl+Shift+O`) in Keymap und Übersicht (`renderer/keymap.test.ts`, „maps Ctrl+Shift+X to toggleExplorer“, „maps Ctrl+Shift+O to focusExplorer“)
- [x] 3.2 Befehle blenden ein/aus und fokussieren (`renderer/commands.test.ts`, „toggles the explorer panel …“, „shows a hidden explorer panel …“)
- [x] 3.3 Panel (`ExplorerPanel.tsx`), Einbau in `App.tsx`, Menü „Ansicht → Explorer ein-/ausblenden“ (Screenshot-Gruppe `explorer`)

## 4. Screenshots

- [x] 4.1 Gruppe `explorer` mit Präfixen 72 bis 78, Reihenfolge vor `restart` (`main/screenshot.test.ts`, „runs the listed groups …“; `main/scene-prefixes.test.ts`)
- [x] 4.2 Leck-Prüfung liest das Panel und lehnt `/home/<name>` dort ab (`main/screenshot-prompt.test.ts`, „finds a user folder in a path of the explorer panel …“)

## 5. Dokumentation

- [x] 5.1 ADR 0002 (Version 1.9), ADR 0006 (Explorer-Panel), ADR 0009 (Panel); geprüft durch `bash scripts/openspec-check.sh --specs`
