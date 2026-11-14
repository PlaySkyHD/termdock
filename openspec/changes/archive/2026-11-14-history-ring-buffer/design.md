# Design

## Context

ADR 0004 legt den Verlauf als Ringpuffer aus zwei Segmentdateien fest. Die Registry meldet jede Ausgabe über `onOutput` (Sessions und PTYs sind dort schon abgebildet). Das Settings-Repository (#60) und das Löschen (#57) entstehen parallel; beide hängen nur an Pfad und Schnittstelle dieser Änderung.

## Goals / Non-Goals

**Goals:** Plattenverbrauch je Session nie über dem Limit, mindestens Limit / 2 der jüngsten Ausgabe erhalten, PTY-Ausgabe wartet nie auf die Platte, Leser für die Suche.

**Non-Goals:** Einstellungen persistieren (#60), Verlauf löschen (#57), Suche und Escape-Entfernung (#62), `loggingEnabled` ändern (#57).

## Decisions

- **Aktives Segment = das mit dem jüngsten ersten Eintrag.** Es gibt keine Metadatei. Beim ersten Schreiben einer Session liest der Store den Zeitstempel des ersten Eintrags beider Segmente; das jüngere ist aktiv, bei gleichem Zeitstempel entscheidet die Änderungszeit, dann `a` vor `b`. Der Leser nutzt dieselbe Ordnung (älteres Segment zuerst). Alternative: Zähler oder Marker in der Datenbank; verworfen, weil der Verlauf dann nicht ohne die Datenbank lesbar wäre und ein Absturz zwischen beiden Schreibvorgängen sie auseinanderlaufen ließe.
- **Zeitstempel gehen nie zurück.** Beim Schreiben wird jeder Zeitstempel auf mindestens den des letzten Eintrags gehoben (nach einem Neustart gilt der letzte Eintrag des aktiven Segments). Sonst könnte eine zurückgestellte Uhr die Segmentreihenfolge umdrehen und das Leeren beim Wechsel träfe das jüngere Segment.
- **Segmentwechsel vor dem Eintrag, der nicht mehr passt.** Ist `Größe + Eintrag > Limit / 2` und das Segment nicht leer, wird das andere Segment geleert (`writeFile(…, "")`) und aktiv. So bleibt jedes Segment unter Limit / 2, beide zusammen unter dem Limit, und nach dem Wechsel liegt mindestens ein volles Segment (über Limit / 2 minus Eintragsgröße) vor.
- **Einträge höchstens 16 KiB.** Längere Ausgabe wird beim Einreihen geteilt. Das hält jeden Eintrag unter dem kleinsten Segment (Limit mindestens 64 KiB, Segment 32 KiB) und gibt dem Leser eine Plausibilitätsgrenze: Eine größere Länge gilt als Beschädigung, der Rest des Segments wird nicht gelesen (kein Speicherbedarf aus Müllwerten).
- **Begrenzte Warteschlange, Verwerfen der ältesten.** Je Session höchstens 1 MiB wartende Bytes. Ist sie voll, fallen die ältesten wartenden Einträge heraus (`droppedEntries`, `droppedBytes` in `stats`); der neueste Stand bleibt. `append` kopiert die Bytes in einen eigenen Puffer, rechnet nichts auf der Platte und wirft nie. Ein Flush läuft je Session höchstens einmal gleichzeitig, wartet 25 ms (gebündelte Schreibvorgänge) und schreibt die ganze Warteschlange mit einem `appendFile`. Schlägt ein Schreibvorgang fehl, meldet `onError` ihn, die Einträge zählen als verworfen und die Session liest ihren Zustand beim nächsten Schreiben neu von der Platte. Während eines Flushs eingehende Ausgabe wartet in der neuen Warteschlange; so bremst eine langsame Platte weder die PTY noch den Speicher.
- **Abgeschnittener Eintrag nach Absturz.** Beim ersten Schreiben nach einem Start liest der Store das aktive Segment bis zum letzten vollständigen Eintrag und kürzt den Rest ab, sonst würden neue Einträge hinter dem Müll unlesbar. Der Leser überspringt den unvollständigen Eintrag am Ende ohne Fehler.
- **Limit wird bei jedem Schreiben gelesen.** `getSettings().historyLimitBytes` wird auf `[MIN, MAX]` begrenzt. Eine Änderung gilt ab dem nächsten Segmentwechsel; ein bereits größeres Segment wird nicht gekürzt, sondern beim nächsten Wechsel geleert. Bis dahin kann der Verbrauch das neue, kleinere Limit übersteigen.
- **`loggingEnabled` je Ausgabe aus der Registry.** `recordHistory` ruft `registry.get(sessionId)` je Ausgabe (eine flache Kopie) und liest `loggingEnabled`; so wirkt eine Änderung (#57) sofort ohne Ereignis, und Registry und Store bleiben getrennt. Der Standard für neue Sessions kommt über `defaultLoggingEnabled` (eine Zeile in `registry.ts`), nicht über den Server.
- **Lesen mit `FileHandle`, in 64-KiB-Stücken.** Der Leser ist ein `AsyncGenerator`; die Suche über 10 MiB blockiert den Event-Loop des Cores nicht am Stück.
- **Beim Beenden wird geschrieben, was wartet.** `close()` des Cores ruft `HistoryStore.dispose()` nach `registry.dispose()` und vor dem Schließen der Datenbank auf.

- **Lesen und Schreiben je Session koordiniert.** `HistoryStore.read` zählt Leser je Session; ein Flush wartet, bis keiner liest, und ein neuer Leser wartet, bis ein laufender Schreibvorgang endet. Die Warteschlange füllt sich währenddessen bis zur Obergrenze weiter (danach Verwerfen der ältesten). Ein nicht zu Ende gelesener, nicht mit `return()` beendeter Leser hält den Schreiber auf. Die freie Funktion `readHistory` hat diese Sperre nicht und gilt nur ohne gleichzeitigen Schreiber.
- **`forget` und `remove`.** `forget` setzt ein Merkmal, löscht Timer und Warteschlange, wartet auf einen laufenden Flush und entfernt den Eintrag aus der `logs`-Map (die Map wächst so nicht mit gelöschten Sessions); ein Flush, der noch nicht schreibt, bricht ab und legt `history/<id>/` nicht an. `remove` löscht danach das Verzeichnis rekursiv und ist idempotent. Neue Ausgabe nach `forget` begänne ein neues Log; der Aufrufer (Löschen einer Session, #57) ruft es erst, wenn die Session nichts mehr ausgibt. Eine nur gelesene Session lässt keinen Map-Eintrag zurück.
- **`findActive` liest nur Header.** Das neueste Segment wird mit 12-Byte-Lesezugriffen an der Position des nächsten Eintrags durchlaufen, die Daten werden übersprungen; der Speicherbedarf ist unabhängig von der Segmentgröße (bis 512 MiB bei 1 GiB Limit).
- **Gesenktes Limit wirkt sofort.** Ändert sich das Segmentmaximum, prüft der nächste Schreibvorgang die Segmentgrößen: Ein zu großes aktives Segment beendet den Verlauf (beide Segmente werden geleert, das andere wird aktiv), ein zu großes inaktives wird geleert. Der Verbrauch liegt danach wieder unter dem Limit; der Preis ist die Ausgabe in den geleerten Segmenten.
- **Bekannte Grenze: Neuzeichnen beim Anhängen.** `requestRedraw` (#34) lässt tmux den Bildschirm neu senden, wenn eine View sich anhängt; diese Bytes kommen als gewöhnliche Ausgabe an der Registry an und stehen als Wiederholung im Verlauf. Die Registry bleibt unverändert (parallel #57); ein Folge-Issue trennt sie von echter Ausgabe.

## Risks / Trade-offs

- Bei hoher Ausgabe über längere Zeit gehen die ältesten wartenden Bytes verloren (gezählt, nicht gemeldet). Das ist gewollt: Eingabe und Anzeige gehen vor.
- Ein Absturz verliert bis zu 25 ms plus die Schreibdauer an Ausgabe.
- Der Verlauf der tmux-Sessions ist die Ausgabe, die der Core als tmux-Client erhält (die gezeichneten Bildschirmänderungen), nicht jedes Byte des Programms (der WSL-Test zeigt: bei 67 MB Programmausgabe kommen rund 2 MB beim Client an).
