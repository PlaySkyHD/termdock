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
