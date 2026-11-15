# Tasks

## 1. Stripper

- [x] 1.1 Test und Umsetzung: `AnsiStripper` behält Backspace, wandelt `ESC[K`/`ESC[0K`/`CSI K` (auch über Chunk-Grenzen) in `ERASE_TO_EOL` und entfernt alle anderen Sequenzen (`storage/history-search.test.ts`, `AnsiStripper`)

## 2. Zeilenmodell

- [x] 2.1 Test und Umsetzung: Zeile mit Cursor im `LineScanner`: Tippfehler mit zwei und vier Korrekturen, Überschreiben nach Backspace, `\r`-Fortschrittsbalken, Backspace über Eintragsgrenzen und am Zeilenanfang, Backspace über den Zeilenpuffer-Schnitt, Position des Treffers (`storage/history-search.test.ts`)
