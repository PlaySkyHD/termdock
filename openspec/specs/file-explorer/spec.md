# file-explorer Specification

## Purpose
Legt fest, wie die Desktop-App Dateien für den Datei-Explorer erreicht: wie Orte in WSL-Distros und auf Windows geprüft und übersetzt werden, was Auflisten, Umbenennen, Verschieben, Löschen, Herunterladen, Zeigen und Öffnen tun, und wie der Renderer sie über eine schmale, geprüfte Brücke aufruft (ADR 0009).

## Requirements

### Requirement: Orte werden im Main geprüft und übersetzt

Der Main SHALL jeden Ort aus dem Renderer vor dem Zugriff prüfen: absoluter Pfad, höchstens 512 Zeichen, keine Steuerzeichen, kein Segment `..`. Ein WSL-Ort SHALL eine dem Core bekannte Distro tragen und wird zu `\\wsl.localhost\<distro>\<pfad>`. Ein Windows-Ort SHALL die Form `X:\…` haben; UNC-, Geräte- und Datenstrom-Pfade MUST abgelehnt werden, (keine NTLM-Anmeldung an fremden Servern). Vom Nutzer verbundene Laufwerke (`Z:\`) sind erlaubt. Ein abgelehnter Ort ergibt `EINVAL`.

#### Scenario: WSL-Pfad wird übersetzt

- **GIVEN** die Distro `Ubuntu` ist dem Core bekannt
- **WHEN** der Renderer `{ backend: "wsl", distro: "Ubuntu", path: "/home/dev" }` auflisten lässt
- **THEN** liest der Main `\\wsl.localhost\Ubuntu\home\dev`

#### Scenario: Ausbruch und Fremdpfade

- **WHEN** der Renderer einen Ort mit `/a/../b`, einem Zeilenumbruch im Pfad, einer unbekannten Distro, `\\server\share\x` oder `\\?\C:\x` schickt
- **THEN** antwortet jede Operation `{ ok: false, code: "EINVAL" }` und ändert nichts

### Requirement: Auflisten mit Obergrenze

`list` SHALL den Inhalt eines Ordners ohne Rekursion liefern: Name, Typ (`file`, `directory`, `symlink`, `other`), Größe, Änderungszeit und bei einem Symlink den Typ des Ziels, Ordner zuerst, dann nach Name. Der Dienst SHALL höchstens 5000 Einträge liefern und bei mehr `truncated: true` und die Gesamtzahl `total` melden.

#### Scenario: Ordner mit Dateien und Unterordnern

- **GIVEN** ein Ordner mit dem Unterordner `src` und der Datei `a.txt` (5 Bytes)
- **WHEN** der Renderer ihn auflisten lässt
- **THEN** steht `src` (`directory`) vor `a.txt` (`file`, Größe 5), und `truncated` ist `false`

#### Scenario: Mehr Einträge als die Obergrenze

- **GIVEN** ein Ordner mit 5003 Dateien
- **WHEN** der Renderer ihn auflisten lässt
- **THEN** enthält die Antwort 5000 Einträge, `truncated: true` und `total: 5003`

### Requirement: Umbenennen und Verschieben überschreiben nie

`rename` SHALL nur einen Namen annehmen (kein Pfadtrenner, nicht `.` oder `..`, höchstens 255 Bytes, unter Windows ohne `<>:"|?*`). `move` SHALL in einen Ordner desselben Backends und derselben Distro verschieben, nie in sich selbst. Beide MUST mit `EEXIST` antworten, wenn das Ziel ein anderer Eintrag ist (ein Umbenennen, das nur die Groß-/Kleinschreibung ändert, ist erlaubt), und liefern sonst den neuen Ort.

#### Scenario: Umbenennen

- **GIVEN** die Datei `/a.txt`
- **WHEN** der Renderer sie in `b.txt` umbenennt
- **THEN** antwortet der Dienst `{ ok: true, location: /b.txt }` und `/a.txt` gibt es nicht mehr

#### Scenario: Ziel existiert

- **GIVEN** die Dateien `/a` und `/target/a`
- **WHEN** der Renderer `/a` nach `/target` verschiebt
- **THEN** antwortet der Dienst `EEXIST`, und beide Dateien behalten ihren Inhalt

#### Scenario: Name mit Pfadtrenner

- **WHEN** der Renderer `/a.txt` in `../b` oder `x/y` umbenennt
- **THEN** antwortet der Dienst `EINVAL` und `/a.txt` bleibt

### Requirement: Löschen ist endgültig

`delete` SHALL eine Datei oder einen Ordner endgültig und rekursiv entfernen, ohne Papierkorb und ohne eigene Rückfrage; die Rückfrage ist Sache des Renderers. Ein Symlink SHALL selbst entfernt werden, sein Ziel nie. Geschützte Orte MUST mit `EINVAL` abgelehnt werden, ebenso beim Verschieben und Umbenennen: bei WSL `/` samt allem direkt darunter sowie alles direkt unter `/mnt` und `/mnt/wsl` (`/mnt/c` ist Laufwerk C:), bei Windows das Laufwerk. Ein fehlender Eintrag ergibt `ENOENT`.

#### Scenario: Ordner mit Inhalt

- **GIVEN** der Ordner `/dir` mit Unterordner und Dateien
- **WHEN** der Renderer ihn löscht
- **THEN** antwortet der Dienst `{ ok: true }` und `/dir` ist samt Inhalt weg

#### Scenario: Wurzel und fehlender Eintrag

- **WHEN** der Renderer `/` oder `C:\` löscht, oder `/nope`, das es nicht gibt
- **THEN** antwortet der Dienst `EINVAL` bzw. `ENOENT`

#### Scenario: Geschützte Orte

- **WHEN** der Renderer `/mnt/c`, `/mnt/wsl/docker-desktop`, `/home` oder `/usr` löscht, verschiebt oder umbenennt
- **THEN** antwortet der Dienst jedes Mal `EINVAL`, und `/mnt/c/Users` oder `/home/dev` bleiben löschbar

#### Scenario: Symlink auf einen Ordner

- **GIVEN** ein Linux-Symlink `/tmp/x/link` auf den Ordner `/tmp/x/target` mit einer Datei
- **WHEN** der Renderer `/tmp/x/link` löscht
- **THEN** ist der Symlink weg, und `target` samt Datei bleibt

### Requirement: Herunterladen nach Windows

`download` SHALL eine WSL-Datei oder einen WSL-Ordner nach Windows kopieren; das Ziel wählt der Nutzer in einem Dialog des Main, dessen Pfad absolut sein MUST und kein `\\?\`- oder Geräte-Präfix tragen darf. Ein Ordner SHALL rekursiv kopiert werden; Symlinks und für Windows ungültige Namen werden übersprungen und in `skipped` gezählt. Der Name des Quellordners MUST für Windows gültig sein (sonst `EINVAL`). Ein vorhandener Zielordner ergibt `EEXIST`.

#### Scenario: Datei speichern

- **GIVEN** die WSL-Datei `/a.txt` und ein Speichern-Dialog, der `C:\out\saved.txt` liefert
- **WHEN** der Renderer sie herunterladen lässt
- **THEN** liegt der Inhalt in `C:\out\saved.txt`, und die Quelle bleibt

#### Scenario: Abbruch und Windows-Quelle

- **WHEN** der Nutzer den Dialog abbricht, oder der Renderer eine Windows-Datei herunterladen lässt
- **THEN** antwortet der Dienst `{ ok: true, cancelled: true }` bzw. `EINVAL`

### Requirement: Zeigen und Öffnen

`reveal` SHALL den Eintrag mit `shell.showItemInFolder` im Windows-Explorer zeigen, `open` ihn mit `shell.openPath` mit dem zugeordneten Programm öffnen. Beide SHALL einen fehlenden Eintrag mit `ENOENT` beantworten, ohne die Shell aufzurufen. `open` MUST Dateien ablehnen (`EINVAL`), die Windows als Programm oder Skript startet (feste Liste, dazu die Endungen aus `PATHEXT`). Eine Fehlermeldung der Shell MUST NOT an den Renderer gehen.

#### Scenario: Programm öffnen

- **GIVEN** die Datei `/tool.exe`
- **WHEN** der Renderer sie öffnen lässt
- **THEN** antwortet der Dienst `EINVAL` und ruft `shell.openPath` nicht auf

#### Scenario: Weitere Programmtypen

- **GIVEN** die Dateien `/a.pyz`, `/b.rdp`, `/c.appinstaller` und `/d.foo` (`.foo` steht in `PATHEXT`)
- **WHEN** der Renderer sie öffnen lässt
- **THEN** antwortet der Dienst jedes Mal `EINVAL`

#### Scenario: Textdatei zeigen und öffnen

- **GIVEN** die Datei `/a.txt`
- **WHEN** der Renderer sie zeigen und öffnen lässt
- **THEN** erhält die Shell den UNC-Pfad der Datei, und beide Antworten sind `{ ok: true }`

### Requirement: Ergebnisse statt Ausnahmen, keine Pfade im Log

Jede Operation SHALL mit `{ ok: true, … }` oder `{ ok: false, code }` antworten, mit `code` aus `ENOENT`, `EACCES`, `EEXIST`, `EINVAL`, `OTHER`; über die Brücke MUST keine Ausnahme laufen. Der Dienst SHALL nur Operation und Code loggen, nie einen Pfad oder die Meldung des Betriebssystems.

#### Scenario: Fehler wird zum Code

- **WHEN** `list` für einen fehlenden Ordner `/td-secret` aufgerufen wird
- **THEN** antwortet der Dienst `{ ok: false, code: "ENOENT" }` und das Log enthält `files.list: ENOENT`, aber nicht `td-secret`

### Requirement: Schmale Brücke mit eigenem Kanal

Der Main SHALL Anfragen des Renderers über den Kanal `termdock:files` entgegennehmen und deren Form prüfen (Methode, Orte, Namen als Strings); unbekannte Methoden und fehlerhafte Formen MUST mit `{ ok: false, code: "EINVAL" }` beantwortet werden, ohne den Dienst aufzurufen. Der Preload SHALL die Aufrufe als `window.termdock.files` bereitstellen und einen abgelehnten Aufruf als `OTHER` melden. Der Dienst nimmt keine Shell-Strings an und startet keine Prozesse.

#### Scenario: Unbekannte Methode

- **WHEN** der Renderer `{ method: "exec", location }` an den Kanal schickt
- **THEN** antwortet der Main `{ ok: false, code: "EINVAL" }`

#### Scenario: Fenster der Anfrage

- **GIVEN** ein Aufruf von `download` aus Fenster 7
- **WHEN** der Main den Dialog öffnet
- **THEN** gehört der Dialog zu Fenster 7

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

Das Verzeichnis einer Windows-Shell (OSC 9;9 ihrer View) SHALL in denselben Store gehen wie das einer WSL-Session aus dem Core; melden mehrere Views denselben Pfad, ändert sich der Store nicht. Nach einem Neustart SHALL die Session das letzte Verzeichnis ihrer View wieder bekommen. Eine WSL-Session ohne Distro im Store SHALL die Standard-Distro von WSL nutzen (`wsl.distros`, nur gefragt, wenn das Panel sie braucht).

#### Scenario: Neustart einer Windows-Session

- **GIVEN** eine Windows-Session in `C:\proj`, die endet und mit „Neu starten“ in derselben View wieder läuft
- **WHEN** ihre neue Shell wieder `C:\proj` meldet
- **THEN** zeigt das Panel `C:\proj`, nicht „Verzeichnis unbekannt“

#### Scenario: Windows-Shell

- **GIVEN** eine `cmd`-Session in `C:\Users\Public`
- **WHEN** der Nutzer `cd termdock-shot` eingibt
- **THEN** zeigt das Panel `C:\Users\Public\termdock-shot`

#### Scenario: WSL-Session ohne Distro

- **GIVEN** eine WSL-Session ohne `launch.distro` im Store und die Standard-Distro `Ubuntu`
- **WHEN** ihr Verzeichnis `/tmp` bekannt wird
- **THEN** listet das Panel `{ backend: "wsl", distro: "Ubuntu", path: "/tmp" }`

### Requirement: Ein- und Ausblenden und Breite

`Ctrl+Shift+X` und der Menüeintrag „Ansicht → Explorer ein-/ausblenden“ SHALL das Panel ein- und ausblenden; ohne gespeicherten Wert ist es sichtbar, und das Terminal behält den Fokus. Der Trenner an seiner linken Kante SHALL die Breite ändern: 180 bis 640 Pixel, und die Panes behalten mindestens 240 Pixel, auch in einem schmaler gezogenen Fenster. Sichtbarkeit und Breite SHALL je Fenster im Layout stehen (`explorerVisible`, `explorerWidth`) und beim Start wiederhergestellt werden.

#### Scenario: Ausblenden bleibt

- **GIVEN** ein Fenster mit sichtbarem Panel
- **WHEN** der Nutzer `Ctrl+Shift+X` drückt und das Layout gespeichert wird
- **THEN** ist das Panel weg, das Terminal hat den Fokus, und das gespeicherte Fenster hat `explorerVisible: false`

#### Scenario: Einblenden lässt den Fokus im Terminal

- **GIVEN** der Nutzer hat den Baum früher mit `Ctrl+Shift+O` fokussiert und das Panel danach ausgeblendet
- **WHEN** er es mit `Ctrl+Shift+X` wieder einblendet
- **THEN** behält das Terminal den Fokus

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
