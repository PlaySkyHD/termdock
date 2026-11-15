# Design

## Kontext

`AnsiStripper` entfernt Escape-Sequenzen und alle Steuerzeichen außer Tab, CR und LF; `LineScanner` schneidet den Text an CR und LF in Zeilen. Backspace (`0x08`) und `ESC[K` fallen so weg, statt die Zeile zu ändern: `echo Apfelk` `i` `u` `c` `h` `\b\x1b[K` `\b\x1b[K` … erscheint mit den Tippfehlern.

## Entscheidungen

### Der Stripper behält, was das Zeilenmodell braucht

`AnsiStripper` gibt Backspace weiter und ersetzt `ESC[K` und `ESC[0K` (auch `CSI K` als C1-Zeichen `0x9b`) durch ein NUL (`ERASE_TO_EOL`). NUL kommt im Text sonst nie vor, weil der Stripper es als Steuerzeichen verwirft. Die Parameter der CSI-Sequenz werden dafür auf höchstens 8 Zeichen mitgelesen; jede andere Sequenz (auch `ESC[1K`, `ESC[2K`, `ESC[?K`) wird wie bisher nur entfernt. Das gilt über Eintragsgrenzen, weil der Zustand im Stripper liegt.

### Zeilenmodell im `LineScanner`

Eine Zeile mit Cursor (0 bis Länge): Text überschreibt ab dem Cursor oder verlängert die Zeile, `\b` setzt den Cursor um eins zurück (mindestens 0), NUL schneidet die Zeile am Cursor ab, `\r` setzt den Cursor auf 0, `\n` beendet die Zeile. `\r\n` ergibt so die vollständige Zeile; `10%\r20%\r100%\n` ergibt `100%`. Ein Zeichen ist eine UTF-16-Einheit; ein Backspace über ein Zeichen außerhalb der BMP löscht nur eine Hälfte (nicht behandelt, weil der Fall selten ist und nur die Anzeige betrifft).

Gesucht wird erst, wenn die Zeile endet (oder der Zeilenpuffer überläuft): Der Treffer und seine Position stammen aus derselben fertigen Zeile, die der Benutzer sieht. Ein Zwischenstand (`10%`) ist kein Treffer mehr. Der Zeitstempel bleibt der des Eintrags, in dem die Zeile begann.

### Grenzen

`MAX_SEARCH_LINE_BUFFER` gilt unverändert: Wird die Zeile länger, wird der vordere Teil durchsucht und abgeschnitten (mit Überlappung für Treffer über den Schnitt); der Cursor wird um die abgeschnittene Länge verschoben, nicht unter 0. Spätere Änderungen betreffen dann nur den Rest der Zeile. `MAX_ESCAPE_RUN`, Trefferlimits und Zeitlimit bleiben.

## Risiken

- Eine Anwendung, die mit `\r` die Zeile neu zeichnet, ohne den Rest zu löschen, zeigt den Rest der alten Zeile weiter an (wie ein Terminal). Das Modell hält sich daran.
- Ein TUI mit Cursorsprüngen (`ESC[H`, `ESC[nC`) wird nicht nachgebildet; seine Zeilen bleiben wie bisher nur von Sequenzen befreit.
