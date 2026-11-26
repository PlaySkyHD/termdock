# Proposal

## Why

Der Datei-Explorer (#198) soll rechts im Fenster das aktuelle Verzeichnis der Shell im aktiven Pane zeigen, wie in VS Code, für WSL- und Windows-Sessions. Die Bausteine sind da: das Verzeichnis je WSL-Session aus dem Core (#199), das Verzeichnis einer Windows-Shell aus ihrem Prompt-Hook (#200) und der geprüfte Dateizugriff im Main (#201, ADR 0009). Es fehlt das Panel selbst (#202).

## What Changes

- Renderer: Explorer-Panel rechts neben dem Pane-Bereich. Kopfzeile mit gekürztem Pfad (voller Pfad im Tooltip), „Aktualisieren“ und „Explorer ausblenden“; Baum mit Ordnern zuerst in der Reihenfolge des Dienstes, Ordner werden beim Aufklappen gelistet (`files.list`), Hinweis bei abgeschnittener Liste. Zustände „Kein Tab offen“, „Session nicht gefunden“, „Session läuft nicht“, „Verzeichnis unbekannt“, „Lädt …“, Fehler des Dienstes als Text, leerer Ordner.
- Das Panel folgt der Session des aktiven, schreibenden Panes im aktiven Tab (sonst eines schreibenden Panes des Tabs, sonst des aktiven Panes). Bei `cd`, Tab- und Pane-Wechsel lädt es neu und verwirft aufgeklappte Ordner; veraltete Antworten verwirft es.
- Das Verzeichnis einer Windows-Shell (OSC 9;9 im `TerminalController`, #200) geht in denselben Store wie das der WSL-Sessions (`relayCwd`), das Panel liest eine Quelle. Für eine WSL-Session ohne Distro im Store (der Core meldet `session.created` vor dem Festlegen der Distro) nimmt es die Standard-Distro von WSL (`wsl.distros`).
- Tastatur: `Ctrl+Shift+X` blendet das Panel ein und aus, `Ctrl+Shift+O` setzt den Fokus in den Baum (beides in der zentralen Keymap und der Übersicht; `Ctrl+Shift+E` teilt schon). Pfeiltasten, Pos1/Ende, Enter (Datei öffnen, Ordner auf-/zuklappen), Escape zurück ins Terminal. Doppelklick auf eine Datei öffnet sie (`files.open`), ein Fehler steht als Hinweis im Panel. Menü „Ansicht → Explorer ein-/ausblenden“.
- Breite per Trenner (180 bis 640 Pixel, die Panes behalten mindestens 240 Pixel). Sichtbarkeit und Breite je Fenster im Layout.
- Protokoll 1.9: optionale Felder `explorerVisible` (Boolean) und `explorerWidth` (positive Zahl) in `LayoutWindow`; die Prüfung kennt sie. Ein Core 1.8, der nach einem Update noch läuft, lehnt sie ab; der Main speichert das Layout dann ohne sie.
- Screenshot-Szenengruppe `explorer` (Präfixe 72 bis 78). Im Screenshot-Modus öffnen neue Fenster ohne Panel, weil andere Gruppen Sessions im Home-Ordner zeigen (Pfad mit Benutzername); die Leck-Prüfung (#191) liest auch Kopfzeile und Zeilen des Panels.

Phase: Erweiterung nach V1 (Datei-Explorer, Stufe 1, Eltern-Issue #198).

## Capabilities

### New Capabilities

Keine.

### Modified Capabilities

- `file-explorer`: Panel, Auswahl der Session, Baum, Zustände, Tastatur, Öffnen, Breite und Sichtbarkeit, Screenshot-Szenen (ADDED).
- `layout-persistence`: „Layout-Dokument“ mit `explorerVisible` und `explorerWidth` (MODIFIED).
- `ipc-protocol`: Versionsszenario in „Neustart im Vertrag“ auf 1.9 (MODIFIED).
- `desktop-shell`: „Zentrale Keymap“ mit den Kürzeln des Explorers, „Screenshot-Modus wählt Szenengruppen“ mit `update` und `explorer` (MODIFIED).

## Impact

- Pakete: `packages/protocol` (`model.ts`, `guards.ts`, Version 1.9), `packages/core` nur Tests (`ipc/ipc.test.ts`: Version, Layout mit Explorer-Feldern), `apps/desktop`: neue reine Module `renderer/explorer-tree.ts`, `explorer-source.ts`, `explorer-keys.ts`, `explorer-view.ts`, Komponente `renderer/ExplorerPanel.tsx`; geändert `App.tsx`, `ui-store.ts`, `keymap.ts`, `commands.ts`, `session-cwd.ts`, `styles.css`, `shared/bridge.ts` (Event `toggleExplorer`), `shared/layout-mapping.ts`, `main/bridge.ts`, `main/layout-coordinator.ts`, `main/main.ts` (Menü, Screenshot-Fenster), Screenshot-Gruppe `main/screenshot-explorer.ts`, `screenshot-prompt.ts`.
- IPC: keine neue Methode und kein Event; zwei optionale Layoutfelder, Version 1.9.
- Abhängigkeiten: keine neue.
- Security: Das Panel ruft nur die geprüfte Brücke `window.termdock.files` (ADR 0009); Pfade kommen aus Core und Store, der Main prüft sie. Dateinamen werden als Text gezeigt, nie als HTML. Programme und Skripte öffnet `files.open` nicht.
- Non-Goals: Dateiaktionen (Kontextmenü, Umbenennen, Verschieben, Löschen, Herunterladen, Ziehen) folgen mit #203 auf demselben Baum-Modell; kein Dateiwächter (ADR 0009); kein Lösen von der Shell (#205).
- Breaking Changes: keine. Ein Client 1.8 liest ein Layout mit den neuen Feldern nicht (er kennt sie nicht und lehnt das Dokument ab); Clients und Core kommen aber aus einem Paket.
