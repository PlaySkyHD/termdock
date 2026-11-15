# Design

## Kontext

Die Kennzeichnung aus #88 gilt nur für die Ausgabe während eines Backend-Aufrufs, den die Registry selbst anfordert (`requestRedraw` nach dem Anhängen). `resize` ruft nur `pty.resize` auf. Der Weg danach: ConPTY → `wsl.exe` → Linux-PTY (`TIOCSWINSZ`) → SIGWINCH an den tmux-Client → `MSG_RESIZE` an den Server → tmux setzt Scrollregion, Mausmodi und Cursor zurück und zeichnet den ganzen Client neu. Für den Core gibt es kein Ereignis, an dem dieses Neuzeichnen endet.

Befund (Ursache belegt):

- Verlaufsformat (`history-store.ts`): `uint64 Zeitstempel | uint32 Länge | Bytes`, ohne Kennzeichen. Gekennzeichnete Ausgabe wird gar nicht geschrieben (`history-recorder.ts`). Jede Wiederholung im Verlauf ist also ungekennzeichnet angekommen.
- Echter Verlauf (zwei Sessions, viele Fenstergrößen): Paare aus einem Eintrag `… ESC[1;1H ESC[1;59r …` (Zurücksetzen nach der Größenänderung) und im selben Millisekundenschritt der ganze Bildschirm (`ESC[?25l … ESC[H … ESC[K\r\n …`). Beim Ziehen des Fensters alle 60 bis 80 ms ein Paar.
- WSL-Messung (tmux 3.6, Socket `termdock-test`): erste Ausgabe rund 110 ms nach `session.resize`; der Verlauf wuchs um den Bildschirm. Eine Größenänderung auf die bisherige Größe erzeugte keine Ausgabe.

## Entscheidung

**Größenänderung fordert ein Neuzeichnen an.** `resize` ruft vor `pty.resize` `requestRedraw` auf, wenn die Session eine PTY hat und sich `cols` oder `rows` ändern. Damit gilt die Kennzeichnung aus #88 ab dem Aufruf von `resize` (synchron gesetzt, bevor ein Byte ankommen kann) bis zum Ende des `refresh-client`-Laufs. Das Ende ist wieder ein Core-Ereignis, kein geschätztes Zeitfenster.

Warum das Neuzeichnen von tmux in diesen Lauf fällt: Der Lauf braucht zwei `wsl.exe`-Aufrufe (`list-clients`, `refresh-client`, zusammen gemessen rund 270 ms), das Neuzeichnen nach SIGWINCH kam nach rund 110 ms. Der SIGWINCH-Weg startet keinen Prozess, `refresh-client` startet zwei; eine feste Reihenfolge garantiert tmux dafür nicht, gemessen lag das Neuzeichnen immer davor (siehe Grenzen). Der zusätzliche Aufruf schadet nicht: Er zeichnet den Bildschirm, den die Views ohnehin gerade bekommen, noch einmal und stellt ihn nach schnellen Größenänderungen sicher richtig her.

Folgen schneller Größenänderungen (Fenster ziehen) werden wie beim Anhängen zusammengefasst: höchstens ein laufender und ein folgender Aufruf je Session. Solange gezogen wird, ist die Ausgabe gekennzeichnet; der letzte Aufruf beginnt nach der letzten Größenänderung.

Gleiche Größe: kein Neuzeichnen, weil tmux nichts schickt (gemessen) und sonst jeder wiederholte `resize` des Renderers `wsl.exe` startete. `pty.resize` wird weiter aufgerufen wie bisher.

## Grenzen

- Programmausgabe während eines solchen Laufs fehlt im Verlauf (wie bei #88: rund 0,3 s je Größenänderung, beim Ziehen die ganze Dauer plus ein Lauf). Ihr Ergebnis steht im neu gezeichneten Bildschirm, den die Views bekommen.
- Kommt das Neuzeichnen nach SIGWINCH erst nach dem Ende des Laufs an (WSL stark verzögert), wird es gespeichert wie bisher.
- Läuft ein Aufruf schon länger als `redrawOutputMaxMs` (2 s), ist die Kennzeichnung bis zum folgenden Aufruf aus; ein Neuzeichnen in dieser Lücke wird gespeichert.
- Neuzeichnen, das tmux ohne Anlass des Core auslöst, und Backends ohne `redraw` (Windows) bleiben unverändert.

## Verworfene Alternativen

- **Festes Zeitfenster nach `resize`:** Die Dauer bis zum Neuzeichnen hängt von WSL-Last ab; jede Zahl ist zu kurz oder verschluckt Ausgabe. Mit `refresh-client` gibt es ein Ende im Core.
- **Inhalt erkennen (`ESC[1;<n>r` gefolgt vom Bildschirm):** Schätzung über Bytes, die die ConPTY umformt; Programme setzen Scrollregionen selbst.
- **Verlauf aus dem Pane per `pipe-pane` statt aus dem Client-PTY:** beseitigt alle Neuzeichnen grundsätzlich, ändert aber Backend-Schnittstelle, ADR 0003/0004 und das Verlaufsformat; eigener Change.
- **Größenänderung im Renderer seltener senden:** betrifft `apps/desktop` und beseitigt die Ursache nicht.
