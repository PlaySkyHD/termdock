## ADDED Requirements

### Requirement: Explorer-Panel rechts neben den Panes

Das Fenster SHALL rechts neben dem Pane-Bereich ein Explorer-Panel zeigen: eine Kopfzeile mit dem aktuellen Pfad (von links gekürzt, voller Pfad im Tooltip), „Aktualisieren“ und „Explorer ausblenden“, darunter den Ordner als Baum in der Reihenfolge des Dateidienstes (Ordner zuerst). Ein Ordner SHALL erst beim Aufklappen gelistet werden; ein abgeschnittenes Listing SHALL „<n> von <gesamt> Einträgen angezeigt“ nennen.

#### Scenario: Ordner mit Dateien

- **GIVEN** eine WSL-Session im Ordner `/tmp/p` mit den Ordnern `docs`, `src` und den Dateien `README.md`, `notes.txt`
- **WHEN** das Panel ihn zeigt
- **THEN** stehen `docs` und `src` vor den Dateien, und die Kopfzeile nennt `/tmp/p`

#### Scenario: Aufklappen lädt bei Bedarf

- **GIVEN** das Panel zeigt `/tmp/p`
- **WHEN** der Nutzer `src` aufklappt
- **THEN** listet das Panel `/tmp/p/src`, zeigt bis zur Antwort „Lädt …“ und danach die Einträge eingerückt unter `src`

### Requirement: Zustände des Panels

Das Panel SHALL statt des Baums einen Text zeigen: „Kein Tab offen“, „Session nicht gefunden“, „Session läuft nicht“ (Session nicht `Running` oder `Detached`), „Verzeichnis unbekannt“ (kein `currentCwd`), „Lädt …“, „Ordner ist leer“ oder den Fehler des Dienstes. Ein Unterordner SHALL Laden, Leere und Fehler als Zeile unter sich zeigen.

#### Scenario: Session beendet

- **GIVEN** das Panel zeigt den Ordner einer Session
- **WHEN** die Shell mit `exit` endet
- **THEN** zeigt das Panel „Session läuft nicht“

#### Scenario: Ordner der Shell gelöscht

- **GIVEN** die Shell steht in einem Ordner, den sie danach löscht
- **WHEN** der Core kein Verzeichnis mehr meldet
- **THEN** zeigt das Panel „Verzeichnis unbekannt“

### Requirement: Fehler des Dienstes als Text

Das Panel SHALL die Codes des Dateidienstes als Text zeigen, nie Pfad oder Meldung des Betriebssystems: `ENOENT` „Ordner nicht gefunden“, `EACCES` „Kein Zugriff auf den Ordner“, `EINVAL` „Dieser Ort kann nicht angezeigt werden“, sonst „Ordner konnte nicht gelesen werden“.

#### Scenario: Ort, den der Dienst ablehnt

- **GIVEN** die Shell steht in `/tmp/p/a\b`
- **WHEN** das Panel den Ordner listet
- **THEN** antwortet der Dienst `EINVAL`, und das Panel zeigt „Dieser Ort kann nicht angezeigt werden“

### Requirement: Panel folgt der Shell

Das Panel SHALL der Session des aktiven Panes im aktiven Tab folgen, wenn es schreibt; sonst einem schreibenden Pane des Tabs; ohne Schreiber dem aktiven Pane. Ändern sich Session, Backend, Distro oder Pfad (`cd`, Tab- oder Pane-Wechsel), SHALL es neu laden und aufgeklappte Ordner und die Auswahl verwerfen. Eine Antwort, die zu einem alten Ordner oder einer älteren Ladung gehört, MUST verworfen werden.

#### Scenario: cd

- **GIVEN** das Panel zeigt `/tmp/p` mit aufgeklapptem `src`
- **WHEN** der Nutzer in der Shell `cd src` eingibt
- **THEN** zeigt das Panel `/tmp/p/src` ohne aufgeklappte Ordner

#### Scenario: Langsame alte Antwort

- **GIVEN** das Panel hat `/a` angefragt, danach wechselte die Shell nach `/b` und wieder nach `/a`
- **WHEN** die erste Antwort für `/a` zuletzt ankommt
- **THEN** ändert sie nichts, und das Panel zeigt die Antwort der letzten Anfrage

### Requirement: Eine Quelle für das Verzeichnis

Das Verzeichnis einer Windows-Shell (OSC 9;9 ihrer View) SHALL in denselben Store gehen wie das einer WSL-Session aus dem Core; melden mehrere Views denselben Pfad, ändert sich der Store nicht. Eine WSL-Session ohne Distro im Store SHALL die Standard-Distro von WSL (`wsl.distros`) nutzen, weil der Core `session.created` vor dem Festlegen der Distro meldet.

#### Scenario: Windows-Shell

- **GIVEN** eine `cmd`-Session in `C:\Users\Public`
- **WHEN** der Nutzer `cd termdock-shot` eingibt
- **THEN** zeigt das Panel `C:\Users\Public\termdock-shot`

#### Scenario: WSL-Session ohne Distro

- **GIVEN** eine WSL-Session ohne `launch.distro` im Store und die Standard-Distro `Ubuntu`
- **WHEN** ihr Verzeichnis `/tmp` bekannt wird
- **THEN** listet das Panel `{ backend: "wsl", distro: "Ubuntu", path: "/tmp" }`

### Requirement: Ein- und Ausblenden und Breite

`Ctrl+Shift+X` und der Menüeintrag „Ansicht → Explorer ein-/ausblenden“ SHALL das Panel ein- und ausblenden; ohne gespeicherten Wert ist es sichtbar. Der Trenner an seiner linken Kante SHALL die Breite ändern: 180 bis 640 Pixel, und die Panes behalten mindestens 240 Pixel. Sichtbarkeit und Breite SHALL je Fenster im Layout stehen (`explorerVisible`, `explorerWidth`) und beim Start wiederhergestellt werden.

#### Scenario: Ausblenden bleibt

- **GIVEN** ein Fenster mit sichtbarem Panel
- **WHEN** der Nutzer `Ctrl+Shift+X` drückt und das Layout gespeichert wird
- **THEN** ist das Panel weg, das Terminal hat den Fokus, und das gespeicherte Fenster hat `explorerVisible: false`

#### Scenario: Breite ziehen

- **GIVEN** das Panel ist 280 Pixel breit
- **WHEN** der Nutzer den Trenner um 80 Pixel nach links zieht
- **THEN** ist es 360 Pixel breit, und das gespeicherte Fenster hat `explorerWidth: 360`

### Requirement: Tastatur im Panel

`Ctrl+Shift+O` SHALL das Panel einblenden und den Baum fokussieren; beide Kürzel stehen in der Keymap und ihrer Übersicht. Im Baum SHALL gelten: Pfeil hoch/runter, Pos1 und Ende wählen; rechts klappt einen Ordner auf oder geht hinein; links klappt zu oder geht zum Elternordner; Enter öffnet eine Datei (`files.open`) oder klappt einen Ordner auf bzw. zu; Escape gibt den Fokus an das Terminal zurück. Keine Taste im Panel MUST das Terminal erreichen.

#### Scenario: Navigation und Rückkehr

- **GIVEN** das Panel zeigt `docs`, `src` (aufgeklappt, darin `lib`), Dateien
- **WHEN** der Nutzer `Ctrl+Shift+O`, Pos1, runter, links, rechts, rechts und Escape drückt
- **THEN** ist erst `src` zu- und wieder aufgeklappt, `src/lib` gewählt, und danach hat das Terminal den Fokus, ohne dass die Shell eine dieser Tasten erhielt

### Requirement: Datei öffnen

Ein Doppelklick auf eine Datei oder Enter SHALL sie mit `files.open` öffnen; ein Klick auf einen Ordner SHALL ihn auf- oder zuklappen. Scheitert das Öffnen, SHALL das Panel einen Hinweis zeigen (bei `EINVAL`: „Programme und Skripte startet der Explorer nicht“), ohne Pfad oder Meldung des Betriebssystems.

#### Scenario: Programm

- **GIVEN** die Datei `tool.exe` im Panel
- **WHEN** der Nutzer doppelt darauf klickt
- **THEN** zeigt das Panel „„tool.exe“ wird nicht geöffnet: Programme und Skripte startet der Explorer nicht“

### Requirement: Screenshot-Szenen des Explorers

Die Szenengruppe `explorer` SHALL aufnehmen: eine WSL-Session nach `cd` in einen Ordner mit Dateien, einen aufgeklappten Ordner, eine `cmd`-Session nach `cd`, das ausgeblendete Panel, den Fehler des Dienstes, „Verzeichnis unbekannt“ und „Session läuft nicht“, jede mit Sichtbarkeitsselektor. Sie MUST unter `/tmp/termdock-shot-<nonce>` und `C:\Users\Public\termdock-shot-<nonce>` arbeiten und beide entfernen.

#### Scenario: Gruppe allein

- **WHEN** die App mit `--scenes explorer` läuft
- **THEN** entstehen die Bilder 72 bis 78, und danach gibt es keinen der beiden Ordner mehr

### Requirement: Kein Benutzername aus dem Panel im Bild

Neue Fenster des Screenshot-Laufs SHALL ohne Panel öffnen, weil andere Gruppen Sessions im Home-Ordner zeigen. Die Leck-Prüfung vor jeder Aufnahme SHALL Kopfzeile und Zeilen des Panels mitlesen und dort auch `/home/<name>` ablehnen.

#### Scenario: Benutzername in der Kopfzeile

- **GIVEN** das Panel zeigt `/home/dev/projekt`
- **WHEN** eine Szene aufnimmt
- **THEN** scheitert sie mit dem Hinweis auf den Benutzernamen
