# Design

## Kontext

Der Core kennt keine Dateien; der Explorer braucht sie im Desktop-Main (ADR 0006). Die Entscheidung mit Alternativen steht in ADR 0009. Hier die Umsetzung.

## Entscheidungen

### Orte statt Pfad-Strings

`FileLocation` ist `{ backend: "wsl"; distro; path }` oder `{ backend: "windows"; path }` (`shared/files.ts`). Der Renderer schickt nie einen fertigen UNC-Pfad; der Main baut ihn aus dem geprüften Ort (`toFsPath`). Dadurch gibt es keinen Weg, `\\server\share` oder `\\?\` zu übergeben.

### Zwei Schichten der Prüfung

`FileBridge` prüft nur die Form (Typen, bekannte Methode) und wirft unbekannte Felder weg. `FileService` prüft jeden Ort inhaltlich (`checkLocation`, Distro gegen die Liste des Core) und jeden Namen (`isValidEntryName`), bevor `fs` aufgerufen wird. Die Liste der Distros kommt als Abhängigkeit aus `wsl.distros` und wird 30 s zwischengespeichert.

### Ergebnisse statt Ausnahmen

Jede Operation läuft in `guard`: eine Ausnahme wird zu einem Code (`codeOf`), nur `files.<operation>: <code>` wird geloggt. Der Preload macht aus einem abgelehnten `invoke` ein Ergebnis `OTHER`, damit der Renderer nie eine Ausnahme sieht.

### Abhängigkeiten statt Electron im Dienst

`dialogs` (Speichern-Dialog, Ordnerwahl) und `shell` (`showItemInFolder`, `openPath`) werden injiziert; `wslRoot` bildet in Tests eine Distro auf einen temporären Ordner ab. So laufen alle Tests ohne Electron und ohne WSL; ein Test gegen das echte `\\wsl.localhost` läuft nur mit `TERMDOCK_WSL_TESTS=1`.

### Keine neue Dependency

Alles geht mit `node:fs/promises` und `node:path`.
