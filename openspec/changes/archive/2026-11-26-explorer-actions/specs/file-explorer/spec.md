## ADDED Requirements

### Requirement: Kontextmenü im Explorer

Eine Zeile des Baums SHALL per Rechtsklick, `Shift+F10` oder Menütaste ein Kontextmenü öffnen, das wie das Sidebar-Menü mit den Pfeiltasten, Enter und Escape bedienbar ist. Einträge: Öffnen (nur Dateien), Herunterladen (nur WSL), Im Windows-Explorer zeigen, Pfad kopieren, Pfad ins Terminal einfügen, Umbenennen, Löschen. Auf einem geschützten Ort (Wurzel, `/x`, `/mnt/x`, `/mnt/wsl/x`, Laufwerk) MUST Umbenennen und Löschen fehlen.

#### Scenario: Ordner in WSL

- **GIVEN** das Panel einer WSL-Session zeigt den Ordner `/tmp/p/src`
- **WHEN** der Nutzer mit rechts auf `src` klickt
- **THEN** zeigt das Menü Herunterladen, Im Windows-Explorer zeigen, Pfad kopieren, Pfad ins Terminal einfügen, Umbenennen und Löschen, aber nicht Öffnen

#### Scenario: Datei unter Windows

- **GIVEN** das Panel einer Windows-Session zeigt die Datei `C:\Users\Public\a.txt`
- **WHEN** der Nutzer das Menü mit `Shift+F10` öffnet
- **THEN** steht Öffnen darin und Herunterladen nicht, und der Fokus liegt auf dem ersten Eintrag

#### Scenario: Geschützter Ort

- **GIVEN** die Shell steht in `/` und das Panel zeigt `/home`
- **WHEN** der Nutzer das Menü auf `home` öffnet
- **THEN** fehlen Umbenennen und Löschen

### Requirement: Umbenennen in der Zeile

`F2` oder der Menüeintrag „Umbenennen“ SHALL den Namen der Zeile durch ein Eingabefeld ersetzen, das den Namen vorbelegt und markiert. Enter SHALL mit `files.rename` umbenennen; Escape oder das Verlassen des Felds SHALL abbrechen. Ein leerer oder unveränderter Name MUST nichts aufrufen. Keine Taste im Feld MUST Baum, Fenster-Kürzel oder Terminal erreichen.

#### Scenario: Neuer Name

- **GIVEN** die Datei `notes.txt` ist gewählt
- **WHEN** der Nutzer `F2` drückt, `todo.txt` eingibt und Enter drückt
- **THEN** ruft das Panel `files.rename` mit `todo.txt`, lädt den Ordner neu, und `todo.txt` ist gewählt

#### Scenario: Unverändert

- **GIVEN** das Feld zeigt `notes.txt`
- **WHEN** der Nutzer ohne Änderung Enter drückt
- **THEN** ruft das Panel nichts auf, und das Feld schließt

### Requirement: Löschen mit Rückfrage

`Entf` oder der Menüeintrag „Löschen …“ SHALL einen modalen Dialog öffnen, der den Namen nennt, bei Ordnern auch die Anzahl der direkten Einträge (aus `files.list`), und sagt, dass das Löschen endgültig ist, für WSL und Windows gleich. Der Fokus SHALL zuerst auf „Abbrechen“ liegen, Escape bricht ab. Erst „Löschen“ SHALL `files.delete` aufrufen; danach lädt der Ordner neu.

#### Scenario: Ordner mit Einträgen

- **GIVEN** der Ordner `docs` mit drei Einträgen ist gewählt
- **WHEN** der Nutzer `Entf` drückt
- **THEN** nennt der Dialog `docs` und „3 Einträge“, der Fokus liegt auf „Abbrechen“, und nichts ist gelöscht

#### Scenario: Bestätigt

- **GIVEN** der Dialog für `notes.txt` ist offen
- **WHEN** der Nutzer „Löschen“ wählt
- **THEN** ruft das Panel `files.delete`, der Dialog schließt, und `notes.txt` steht nicht mehr im Baum

### Requirement: Verschieben per Ziehen

Eine Zeile SHALL sich auf eine Ordnerzeile oder die Kopfzeile (das aktuelle Verzeichnis) ziehen lassen; Loslassen SHALL `files.move` aufrufen, beide Ordner neu laden und den verschobenen Eintrag im aufgeklappten Ziel wählen. Gültige Ziele MUST weder der Eintrag selbst noch ein Pfad darunter noch der Ordner sein, in dem er liegt; ein geschützter Eintrag zieht nicht. Escape SHALL das Ziehen abbrechen, ohne etwas zu verschieben.

#### Scenario: In einen Ordner

- **GIVEN** das Panel zeigt `docs` und `notes.txt`
- **WHEN** der Nutzer `notes.txt` auf `docs` zieht und loslässt
- **THEN** liegt `docs/notes.txt` aufgeklappt und gewählt im Baum, und `notes.txt` steht nicht mehr in der Wurzel

#### Scenario: In sich selbst

- **GIVEN** der Nutzer zieht den aufgeklappten Ordner `src`
- **WHEN** der Zeiger über `src/lib` steht
- **THEN** ist `src/lib` kein gültiges Ziel, und Loslassen verschiebt nichts

#### Scenario: Abbruch

- **GIVEN** der Nutzer zieht `notes.txt` über `docs`
- **WHEN** er Escape drückt und danach loslässt
- **THEN** ruft das Panel `files.move` nicht auf

### Requirement: Herunterladen aus WSL

„Herunterladen …“ (nur WSL) SHALL `files.download` aufrufen; der Main fragt nach dem Ziel. Ein abgebrochener Dialog MUST nichts melden; `skipped > 0` SHALL den Hinweis „1 Eintrag übersprungen“ bzw. „n Einträge übersprungen“ zeigen.

#### Scenario: Übersprungene Einträge

- **GIVEN** ein Ordner mit zwei Symlinks
- **WHEN** der Download mit `skipped: 2` endet
- **THEN** zeigt das Panel „2 Einträge übersprungen“

### Requirement: Pfad kopieren und einfügen

„Pfad kopieren“ SHALL den Pfad über die Zwischenablage der App (`navigator.clipboard`) schreiben, nicht per OSC 52. „Pfad ins Terminal einfügen“ SHALL den Pfad quotiert, ohne Zeilenumbruch und ohne Enter in die schreibende View der Session des Panels einfügen: WSL in POSIX-Single-Quotes (`'` → `'\''`), PowerShell in Single-Quotes (`'` → `''`), `cmd` in Doppelquotes. Ohne Schreiber oder bei einem Pfad mit Steuerzeichen MUST der Eintrag deaktiviert sein.

#### Scenario: Apostroph in WSL

- **GIVEN** die Datei `/tmp/it's.txt` und eine schreibende View der Session
- **WHEN** der Nutzer „Pfad ins Terminal einfügen“ wählt
- **THEN** erhält die Shell `'/tmp/it'\''s.txt'` ohne Enter

#### Scenario: Nur lesende View

- **GIVEN** das Panel folgt einem lesenden Pane, und im Tab schreibt keins
- **WHEN** der Nutzer das Menü öffnet
- **THEN** ist „Pfad ins Terminal einfügen“ deaktiviert, und kein Pane erhält Eingabe

### Requirement: Fehler der Dateiaktionen

Scheitert eine Aktion, SHALL das Panel einen Hinweis mit dem Namen zeigen, nie Pfad oder Meldung des Betriebssystems: `EEXIST` (Name schon vergeben), `EACCES` (kein Zugriff), `ENOENT` (gibt es nicht mehr), `EINVAL` (ungültiger Name oder nicht erlaubt), sonst „konnte nicht …“. Danach SHALL der betroffene Ordner neu laden.

#### Scenario: Name vergeben

- **GIVEN** der Ordner enthält `README.md` und `notes.txt`
- **WHEN** der Nutzer `notes.txt` in `README.md` umbenennt
- **THEN** zeigt das Panel „„README.md“ gibt es in diesem Ordner schon“, lädt den Ordner neu, und beide Dateien bleiben

### Requirement: Screenshot-Szenen der Dateiaktionen

Die Szenengruppe `explorer` SHALL zusätzlich aufnehmen: das offene Kontextmenü einer WSL-Zeile, das aktive Umbenennen, den Lösch-Dialog, den Hinweis nach `EEXIST` und den Baum nach erfolgreichem Umbenennen und Verschieben, jede mit Sichtbarkeitsselektor, mit Pfaden unter `/tmp` und ohne den nativen Download-Dialog.

#### Scenario: Gruppe allein

- **WHEN** die App mit `--scenes explorer` läuft
- **THEN** entstehen zusätzlich die Bilder `75a` bis `75e`, und jede Szene prüft ihren Endzustand im Panel
