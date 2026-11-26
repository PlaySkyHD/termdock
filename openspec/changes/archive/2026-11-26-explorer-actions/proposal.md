# Proposal

## Why

Das Explorer-Panel (#202) zeigt das Verzeichnis der Shell, aber mit den Dateien lässt sich darin nichts tun. Der geprüfte Dateidienst (#201, ADR 0009) kann schon umbenennen, verschieben, löschen, herunterladen, zeigen und öffnen. Es fehlen die Bedienung im Panel und die Rückfrage vor dem Löschen, die ADR 0009 dem Renderer zuweist (#203, Eltern-Issue #198).

## What Changes

- Kontextmenü auf einer Zeile des Baums (Rechtsklick, `Shift+F10`, Menütaste; Tastatur wie im Sidebar-Menü): Öffnen (nur Dateien), Herunterladen (nur WSL), Im Windows-Explorer zeigen, Pfad kopieren, Pfad ins Terminal einfügen, Umbenennen, Löschen. Welche Einträge erscheinen, bestimmt eine reine Funktion je Backend und Typ; auf geschützten Orten (Wurzel, `/x`, `/mnt/x`, `/mnt/wsl/x`, Laufwerk) fehlen Umbenennen und Löschen.
- Umbenennen in der Zeile: `F2` oder Menü, Enter bestätigt, Escape oder Verlassen des Felds bricht ab; ein leerer oder unveränderter Name ändert nichts.
- Löschen: `Entf` oder Menü, immer mit Rückfrage-Dialog (Fokus zuerst auf „Abbrechen“), endgültig für WSL und Windows; der Dialog nennt den Namen, bei Ordnern die Anzahl der direkten Einträge.
- Verschieben per Ziehen einer Zeile auf einen Ordner oder die Kopfzeile (aktuelles Verzeichnis); nie in sich selbst, einen eigenen Unterordner oder den Ordner, in dem der Eintrag schon liegt; Escape bricht ab.
- Herunterladen (nur WSL) über `files.download`; „n Einträge übersprungen“ bei `skipped > 0`, ein abgebrochener Dialog meldet nichts.
- Pfad kopieren über `navigator.clipboard` (der Weg der App, kein OSC 52). Pfad einfügen nur in die schreibende View der Session des Panels, ohne Zeilenumbruch und ohne Enter, passend quotiert (POSIX für WSL, PowerShell, `cmd`); ohne Schreiber ist der Eintrag deaktiviert.
- Fehler (`EEXIST`, `EACCES`, `ENOENT`, `EINVAL`, sonst allgemein) als Hinweis im Panel; danach lädt der betroffene Ordner neu, nach Umbenennen und Verschieben bleibt die Auswahl auf dem neuen Eintrag.
- Screenshot-Szenen in der Gruppe `explorer` (Präfix `75a` bis `75e`).

Phase: Erweiterung nach V1 (Datei-Explorer, Stufe 1, Eltern-Issue #198).

## Capabilities

### New Capabilities

Keine.

### Modified Capabilities

- `file-explorer`: Kontextmenü, Umbenennen, Löschen, Verschieben, Herunterladen, Pfad kopieren und einfügen, Fehler der Aktionen, Screenshot-Szenen der Aktionen (ADDED).

## Impact

- Pakete: nur `apps/desktop`. Neue reine Module `renderer/explorer-actions.ts` (Menü, geschützte Orte, Drop-Ziele, Umbenennen, Lösch-Text, Fehlertexte, Baum nach einer Aktion) und `renderer/path-quote.ts` (Quotierung); geändert `renderer/explorer-keys.ts` (`F2`, `Entf`), `renderer/ExplorerPanel.tsx`, `renderer/App.tsx` (Schreiber und Shell der Session ans Panel), `renderer/styles.css`, Screenshot-Gruppe `main/screenshot-explorer.ts`.
- IPC: keine neue Methode, kein neues Event; das Panel nutzt die bestehende Brücke `window.termdock.files`.
- Abhängigkeiten: keine neue.
- Security: Alle Dateizugriffe gehen über den Dateidienst, der jeden Ort prüft (ADR 0009); der Renderer schließt geschützte Orte zusätzlich aus dem Menü aus. Ein eingefügter Pfad ist quotiert und enthält nie Steuerzeichen (ein Name mit Zeilenumbruch wäre sonst ein Enter in der Shell); er geht nur an die schreibende View (Eingabe-Lock). Löschen fragt immer nach.
- Non-Goals: Papierkorb (ADR 0009), Kopieren, Neuer Ordner, Mehrfachauswahl, Ziehen in andere Fenster oder ins Terminal, Dateiwächter, Lösen von der Shell (#205).
- Breaking Changes: keine.
