# Design

## Kontext

`runCore` schreibt über eine lokale Funktion `log` nach stderr; Registry und Verlaufsspeicher haben `console.error` als Standard. Die Desktop-App startet den Core mit `stdio: "ignore"`, also geht alles verloren. Der Main-Prozess nutzt `console.error`.

## Entscheidungen

### Ein Modul im Core, kein Logging-Paket

`packages/core/src/log/` enthält `redact.ts` und `logger.ts`. Der Core braucht nur `fs`; eine Dependency (pino, winston) wäre für eine Datei mit zwei Rotationsstufen mehr Last als Nutzen. Die Desktop-App importiert `createLogger` und `redact` aus `@termdock/core` und baut keine zweite Variante.

### Asynchrone Warteschlange, nie werfen

Jeder Logger hält eine Promise-Kette. Ein Aufruf formatiert und schwärzt die Zeile sofort, hängt das Schreiben an die Kette und kehrt zurück. Ein Fehler (Ordner nicht anlegbar, Datei gesperrt, Platte voll) geht an `onWriteError`, die Kette läuft weiter, und der Logger prüft beim nächsten Schreiben Ordner und Dateigröße neu. Auch ein werfender `mirror` oder `onWriteError` stoppt nichts. `flush()` wartet auf die Kette und wird beim Abbau des Core aufgerufen, damit der Prozess nicht vor dem letzten Eintrag endet.

### Rotation nach Größe

Der Logger kennt die Größe der aktiven Datei (einmal `stat`, danach mitgezählt). Würde eine Zeile die Datei über `maxBytes` heben und ist sie nicht leer, rotiert er: die älteste Datei wird gelöscht, `core.1.log` wird zu `core.2.log` usw., `core.log` zu `core.1.log`. Mit `files = 2` gibt es also nie mehr als `core.log` und `core.1.log`, zusammen etwa 2 MiB je Prozess. Zwei Core-Prozesse teilen sich die Datei nicht: ein zweiter Core scheitert mit `already_running` und schreibt nur nach stderr, damit er den Datenordner nicht anlegt oder anfasst (ADR 0001).

### Zeilenformat

`<ISO-Zeit> <info|warn|error> <Quelle> <Text>`. Mehrzeilige Texte (Stacktrace) werden eingerückt, damit jeder Eintrag mit einer Zeit beginnt. Stacktraces stehen nur in der Datei und auf stderr, nie in IPC-Antworten; dafür sorgt `detailOf` in `run-core.ts`, während die Antworten wie bisher nur die Meldung tragen.

### Schwärzung

`redact` ersetzt, in dieser Reihenfolge: (1) Werte von Umgebungsvariablen mit Secret-Namen aus `process.env`, wo immer sie im Text stehen (ab 6 Zeichen, sonst träfe es Alltagstext), (2) `Authorization: …` bis Zeilenende, (3) `NAME=wert`, `NAME: wert` und JSON-Member, deren Name TOKEN, SECRET, PASSWORD, KEY oder AUTH enthält, (4) Tokenformen `ghp_…`, `github_pat_…`, `sk-…`, `xox…`. Das Muster ist absichtlich großzügig: lieber ein Wort wie `author=` fälschlich schwärzen als ein Geheimnis durchlassen. Terminal-Ausgabe und Startkommandos von Profilen werden nirgends geloggt; die bestehenden Meldungen tragen nur Session-IDs und Fehlermeldungen.

### Datenordner und Menü

Der Datenordner wird wie bisher aufgelöst (`TERMDOCK_DATA_DIR`, sonst `%APPDATA%\TermDock`), `logs/` darin. Lässt er sich nicht auflösen, loggt der Core nur nach stderr und scheitert beim Start mit demselben Grund. Im Screenshot-Lauf schreibt die App in den isolierten Ordner. Das Menü „Hilfe“ entsteht aus `helpMenuTemplate`; „Log-Ordner öffnen“ legt `logs/` an, falls es fehlt, und ruft `shell.openPath`. Ein Fehlerstring von `openPath` kommt ins Desktop-Log.

### Nicht gelöst

Der Desktop-Logger wird beim Beenden der App nicht abgewartet; ein Eintrag unmittelbar vor `app.exit` kann fehlen. Der Core wartet dagegen auf `flush()`.

## Keine neuen Dependencies
