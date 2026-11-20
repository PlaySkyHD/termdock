# history Specification

## Purpose
Legt fest, wie der Core die Ausgabe jeder Session dauerhaft als begrenzten Ringpuffer ablegt: Dateiformat und Ablageort, Limit und Plattenverbrauch, nicht blockierendes Schreiben, Lesen von alt nach neu und Logging je Session.

## Requirements

### Requirement: Ringpuffer aus zwei Segmenten

Der Core SHALL den Verlauf einer Session in `<Datenverzeichnis>/history/<sessionId>/a.log` und `b.log` ablegen. Jeder Eintrag MUST aus `uint64 BE Zeitstempel ms`, `uint32 BE Länge` und den Rohbytes bestehen, höchstens 16 KiB Daten. Ist das aktive Segment bei Limit / 2 voll, SHALL der Core das andere leeren und aktiv machen. Der Verbrauch MUST nie über `historyLimitBytes` liegen, und mindestens Limit / 2 der jüngsten Ausgabe MUST erhalten bleiben.

#### Scenario: Segmentwechsel

- **GIVEN** ein Limit von 64 KiB und eine Session, deren Ausgabe 300 Einträge zu je 1000 Bytes ergibt
- **WHEN** der Core sie speichert
- **THEN** ist keine Segmentdatei größer als 32 KiB, beide zusammen nicht größer als 64 KiB, und die Einträge ab dem ältesten erhaltenen bis zum letzten sind lückenlos lesbar

#### Scenario: Lange Ausgabe

- **GIVEN** eine Ausgabe von 32 KiB und 5 Bytes
- **WHEN** der Core sie speichert
- **THEN** besteht sie aus drei Einträgen (16 KiB, 16 KiB, 5 Bytes), die zusammen die Ausgabe ergeben

#### Scenario: Weiterschreiben nach Neustart

- **GIVEN** ein Verlauf, den ein früherer Core angelegt hat
- **WHEN** ein neuer Core weitere Ausgabe derselben Session speichert
- **THEN** wird im jüngeren Segment fortgesetzt und die Reihenfolge von alt nach neu bleibt erhalten

#### Scenario: Unsichere Session-ID

- **GIVEN** eine Session-ID mit `/`, `\` oder `..`
- **WHEN** der Pfad ihres Verlaufs gebildet wird
- **THEN** lehnt der Core ihn ab

### Requirement: Schreiben blockiert die Ausgabe nie

Der Core SHALL Ausgabe zum Speichern in eine Warteschlange von höchstens 1 MiB je Session einreihen und im Hintergrund schreiben; die PTY-Ausgabe MUST nicht auf die Platte warten. Ist die Warteschlange voll, SHALL der Core die ältesten wartenden Einträge verwerfen und zählen. Ein Schreibfehler MUST gemeldet werden, ohne die Ausgabe zu stören; beim Beenden SHALL der Core wartende Einträge schreiben.

#### Scenario: Rückstau

- **GIVEN** eine Warteschlange von 10 Einträgen und 100 Einträge, bevor die Platte schreibt
- **WHEN** der Core schreibt
- **THEN** stehen die letzten 10 im Verlauf und 90 sind als verworfen gezählt

#### Scenario: Schreibfehler

- **GIVEN** ein Datenverzeichnis, in dem `history/` nicht angelegt werden kann
- **WHEN** Ausgabe einer Session gespeichert werden soll
- **THEN** wirft das Einreihen nicht, der Fehler wird gemeldet und die Einträge zählen als verworfen

#### Scenario: Last von 50 MiB

- **GIVEN** das Standardlimit von 10 MiB und 50 MiB Ausgabe einer Session durch die Registry
- **WHEN** die Ausgabe eingetroffen und geschrieben ist
- **THEN** liegt der Verbrauch zwischen 5 MiB und 10 MiB, die letzte Ausgabe ist enthalten und kein Aufruf der Ausgabe hat auf die Platte gewartet

### Requirement: Lesen von alt nach neu

Der Core SHALL den Verlauf einer Session in Einträgen von alt nach neu lesbar machen (älteres Segment zuerst). Ist der letzte Eintrag eines Segments abgeschnitten (Absturz) oder beschädigt, SHALL der Leser ihn und den Rest dieses Segments ohne Fehler überspringen. Vor dem Weiterschreiben MUST der Core ein solches Ende abschneiden, damit neue Einträge lesbar bleiben.

#### Scenario: Abgeschnittener letzter Eintrag

- **GIVEN** ein Segment mit drei Einträgen, dessen letzter nur zum Teil geschrieben ist
- **WHEN** der Verlauf gelesen wird
- **THEN** liefert der Leser die ersten zwei Einträge ohne Fehler

#### Scenario: Unplausible Länge

- **GIVEN** ein Segment, dessen letzter Header eine Länge über 16 KiB trägt
- **WHEN** der Verlauf gelesen wird
- **THEN** endet der Leser vor diesem Eintrag, ohne den Speicher für die Länge anzufordern

#### Scenario: Weiterschreiben hinter einem abgeschnittenen Eintrag

- **GIVEN** ein Segment mit zwei vollständigen Einträgen und einem halben
- **WHEN** der Core einen neuen Eintrag schreibt
- **THEN** liefert der Leser die zwei ersten und den neuen Eintrag

#### Scenario: Kein Verlauf

- **GIVEN** eine Session ohne gespeicherten Verlauf
- **WHEN** er gelesen wird
- **THEN** liefert der Leser nichts

### Requirement: Logging je Session

Der Core SHALL die Ausgabe einer Session nur speichern, solange `loggingEnabled` der Session wahr ist, und das bei jeder Ausgabe neu prüfen. Abschalten MUST das Schreiben stoppen und vorhandene Daten bestehen lassen. Eine neue Session ohne Angabe SHALL den Wert der Einstellung `historyEnabledByDefault` erhalten; `historyLimitBytes` SHALL bei jedem Schreiben gelten und auf den erlaubten Bereich begrenzt werden.

#### Scenario: Session ohne Logging

- **GIVEN** zwei Sessions, eine mit `loggingEnabled: false`
- **WHEN** beide Ausgabe erzeugen
- **THEN** speichert der Core nur die der ersten; für die zweite entsteht kein Verlaufsverzeichnis

#### Scenario: Abschalten und wieder einschalten

- **GIVEN** eine Session mit gespeicherter Ausgabe „before“
- **WHEN** Logging aus ist und „after“ erscheint, danach wieder an ist und „again“ erscheint
- **THEN** enthält der Verlauf „before“ und „again“ in dieser Reihenfolge

#### Scenario: Standard für neue Sessions

- **GIVEN** `historyEnabledByDefault` ist falsch
- **WHEN** eine Session ohne `loggingEnabled` angelegt wird, und eine mit `loggingEnabled: true`
- **THEN** hat die erste `loggingEnabled: false` und die zweite `true`

#### Scenario: Limit außerhalb des Bereichs

- **GIVEN** ein `historyLimitBytes` von 1 oder kein gültiger Zahlenwert
- **WHEN** der Core ein Segment füllt
- **THEN** gilt 64 KiB (Minimum) beziehungsweise 10 MiB (Standard) als Limit

### Requirement: Lesen neben dem Schreiber

Der Lesezugriff des Stores (`HistoryStore.read`) SHALL den Schreiber der Session und jeden Segmentwechsel bis zum Ende des Lesens aufschieben; die Warteschlange füllt sich bis zu ihrer Obergrenze weiter. Ein Segmentwechsel MUST dem Leser keine Bytes verschieben. Die freie Funktion `readHistory` ist nur ohne gleichzeitigen Schreiber sicher.

#### Scenario: Segmentwechsel während des Lesens

- **GIVEN** zwei volle Segmente, ein offener Lesezugriff und genug neue Ausgabe für einen Segmentwechsel
- **WHEN** der Leser weiterliest und der Core schreiben will
- **THEN** liefert der Leser alle Einträge lückenlos und der Core schreibt erst nach dem Ende des Lesens

#### Scenario: Leser bricht ab

- **GIVEN** ein Lesezugriff, der nach dem ersten Eintrag beendet wird
- **WHEN** neue Ausgabe eintrifft und geschrieben wird
- **THEN** wird sie angehängt und ist lesbar

### Requirement: Verlauf vergessen und entfernen

`HistoryStore.forget` SHALL die wartenden Einträge einer Session verwerfen, einen laufenden Flush abwarten und die Session aus dem Speicher des Stores nehmen; danach MUST kein Flush `history/<sessionId>/` neu anlegen. `HistoryStore.remove` SHALL zusätzlich das Verzeichnis mit beiden Segmenten rekursiv löschen und idempotent sein.

#### Scenario: Vergessen vor dem Schreiben

- **GIVEN** wartende Ausgabe einer Session, die noch nicht geschrieben ist
- **WHEN** der Core die Session vergisst
- **THEN** entsteht `history/<sessionId>/` nicht und die Session hat keinen Eintrag im Store

#### Scenario: Entfernen

- **GIVEN** eine Session mit gespeichertem Verlauf, auch während eines laufenden Flushs
- **WHEN** der Core sie entfernt, auch ein zweites Mal oder für eine unbekannte Session
- **THEN** existiert das Verzeichnis nicht mehr, ohne Fehler und ohne dass ein späterer Flush es neu anlegt

### Requirement: Gesenktes Limit

Wird `historyLimitBytes` gesenkt, SHALL der Core beim nächsten Schreiben mit geändertem Segmentmaximum den Verbrauch sofort wieder unter das Limit bringen: Ist das aktive Segment über dem Maximum, werden beide Segmente geleert; ist nur das inaktive darüber, wird es geleert.

#### Scenario: Zu großes aktives Segment

- **GIVEN** ein Verlauf von rund 400 KiB im aktiven Segment und ein neues Limit von 64 KiB
- **WHEN** der Core Ausgabe schreibt
- **THEN** liegt der Verbrauch höchstens bei 64 KiB und nur die neue Ausgabe ist lesbar

#### Scenario: Zu großes inaktives Segment

- **GIVEN** ein großes inaktives Segment, ein kleines aktives und ein neues Limit von 64 KiB
- **WHEN** der Core Ausgabe schreibt
- **THEN** ist das inaktive Segment leer, das aktive und die neue Ausgabe bleiben

### Requirement: Neuzeichnen beim Anhängen nicht speichern

Fordert die Registry nach dem Anhängen einer View ein Neuzeichnen an, SHALL sie die Ausgabe der PTY, die ein Backend-Aufruf dafür neu zeichnet, während dieses Aufrufs und höchstens 2 s je Aufruf als Neuzeichnen kennzeichnen; ein gescheiterter Aufruf beendet das sofort. Der Verlauf MUST solche Ausgabe nicht speichern, Views MUST sie unverändert erhalten. Übrige Ausgabe SHALL er speichern, auch Neuzeichnen von tmux selbst oder beim Anbinden einer PTY, nicht aber nach einer Größenänderung.

#### Scenario: Neuzeichnen beim Anhängen

- **GIVEN** eine WSL-Session mit Logging, einer angehängten View und gespeicherter Ausgabe „hello“
- **WHEN** eine zweite View anhängt und das angeforderte Neuzeichnen den Bildschirm in die PTY schreibt
- **THEN** entsteht kein neuer Verlaufseintrag, und beide Views erhalten das Neuzeichnen als Ausgabe

#### Scenario: Ausgabe nach dem Neuzeichnen

- **GIVEN** eine Session, deren angefordertes Neuzeichnen beendet ist
- **WHEN** das Programm „after“ ausgibt
- **THEN** speichert der Verlauf „after“ hinter der früheren Ausgabe

#### Scenario: Gescheitertes Neuzeichnen

- **GIVEN** eine Session, deren Neuzeichnen beim Anhängen zweimal scheitert
- **WHEN** danach Ausgabe eintrifft
- **THEN** speichert der Verlauf sie

#### Scenario: Wiederholung nach gescheitertem Aufruf

- **GIVEN** ein Neuzeichnen, dessen erster Backend-Aufruf scheitert
- **WHEN** die Wiederholung den Bildschirm in die PTY schreibt
- **THEN** speichert der Verlauf diese Bytes nicht, die Ausgabe danach aber schon

#### Scenario: Obergrenze je Aufruf

- **GIVEN** ein Backend-Aufruf zum Neuzeichnen, der länger als 2 s dauert (WSL hängt)
- **WHEN** nach diesen 2 s Ausgabe eintrifft
- **THEN** speichert der Verlauf sie

#### Scenario: Wiederanbinden während des Neuzeichnens

- **GIVEN** ein laufender Backend-Aufruf zum Neuzeichnen, während dessen der tmux-Client verloren geht und die Registry eine neue PTY anbindet
- **WHEN** die neue PTY Ausgabe liefert, bevor dieser Aufruf endet
- **THEN** speichert der Verlauf sie, auch den Bildschirm, den tmux beim Anbinden zeichnet; erst die Ausgabe der neuen PTY während eines folgenden Aufrufs wird nicht gespeichert

#### Scenario: Ohne angefordertes Neuzeichnen

- **GIVEN** eine Session, an die gerade keine View mit Snapshot des Backends anhängt (etwa eine Windows-Session oder tmux zeichnet von selbst neu)
- **WHEN** Ausgabe eintrifft
- **THEN** speichert der Verlauf sie wie jede andere Ausgabe

### Requirement: Suche im Verlauf

Der Core SHALL mit `history.search` den gespeicherten Verlauf aller Sessions mit Verlauf, auch archivierter, oder der genannten `sessionIds` durchsuchen: Klartext ohne Beachtung der Groß- und Kleinschreibung, Escape-Sequenzen erst beim Lesen entfernt (nie interpretiert, auch über Eintragsgrenzen), ein Treffer je Zeile mit Session, Zeitstempel und Zeile (höchstens 512 Zeichen) um den Treffer, neueste zuerst. Der Core MUST Verlauf lesen wie `HistoryStore.read` (Lese-Lock gegen Rotation).

#### Scenario: Treffer in zwei Sessions

- **GIVEN** zwei Sessions mit gespeichertem „Build FAILED“ (mit Farbsequenzen) und „tests failed“
- **WHEN** der Client „failed“ sucht
- **THEN** liefert der Core je einen Treffer mit der Zeile ohne Escape-Sequenzen, der Position des Treffers und dem Zeitstempel, den neuesten zuerst

#### Scenario: Zeile über Eintragsgrenzen

- **GIVEN** eine Zeile „hello world“, deren Bytes auf zwei Einträge verteilt sind, und eine Escape-Sequenz, die zwischen zwei Einträgen endet
- **WHEN** der Client „world“ sucht
- **THEN** liefert der Core die Zeile als einen Treffer, und Sequenzen sind weder Treffer noch Teil der Zeile

#### Scenario: Treffer in beiden Segmenten

- **GIVEN** eine Session, deren Ringpuffer gewechselt hat und in beiden Segmenten Treffer enthält
- **WHEN** der Client sucht
- **THEN** liefert der Core die Treffer beider Segmente lückenlos bis zur jüngsten Zeile

#### Scenario: Ohne Verlauf oder gelöscht

- **GIVEN** eine Session mit `loggingEnabled: false`, eine gelöschte Session und ein Verlauf ohne Session
- **WHEN** der Client sucht
- **THEN** liefert der Core für keine von ihnen einen Treffer, auch nicht mit ihrer ID in `sessionIds`

### Requirement: Grenzen der Suche

Die Suche MUST begrenzt bleiben: höchstens `limit` Treffer (Standard und Höchstwert 200), Zeilenpuffer von 4096 Zeichen beim Lesen (mit Überlappung, damit ein Treffer über den Schnitt gefunden wird), Laufzeit von 5 s. Gibt es mehr Treffer oder endet die Zeit, SHALL der Core die neuesten gefundenen Treffer mit `truncated: true` liefern. Ein Suchtext SHALL als Text gelten, nicht als Muster; ein Suchtext mit Zeilenumbruch findet nichts.

#### Scenario: Mehr Treffer als Limit

- **GIVEN** eine Session mit zehn passenden Zeilen
- **WHEN** der Client mit `limit: 3` sucht
- **THEN** liefert der Core die drei neuesten und `truncated: true`; mit `limit: 10` zehn und `truncated: false`

#### Scenario: Zeitgrenze

- **GIVEN** eine Suche, die länger als die Zeitgrenze liest
- **WHEN** die Zeit abläuft
- **THEN** endet sie mit dem bisherigen Ergebnis und `truncated: true`, und der Lese-Lock ist freigegeben

#### Scenario: Rotation während der Suche

- **GIVEN** eine laufende Suche und Ausgabe, die einen Segmentwechsel auslöst
- **WHEN** die Suche liest
- **THEN** liefert sie genau, was bei ihrem Beginn gespeichert war, jede Zeile vollständig und einmal, und das Schreiben läuft danach weiter

#### Scenario: Suchtext mit Sonderzeichen

- **GIVEN** Zeilen „a.c“ und „abc“
- **WHEN** der Client „a.c“ sucht
- **THEN** liefert der Core nur „a.c“

### Requirement: Neuzeichnen nach Größenänderung nicht speichern

Ändert die schreibende View die Größe einer Session mit PTY eines Backends mit Neuzeichnen (WSL), SHALL die Registry vorher ein Neuzeichnen anfordern; dessen Ausgabe ist gekennzeichnet wie beim Anhängen, der Verlauf MUST sie nicht speichern. Größenänderungen während eines Neuzeichnens SHALL sie bis zur Grenze ihrer Kette (nächste Anforderung) zu genau einem folgenden zusammenfassen. Gleiche Größe oder fehlende PTY MUST kein Neuzeichnen anfordern. Views MUST die Ausgabe unverändert erhalten.

#### Scenario: Größenänderung

- **GIVEN** eine WSL-Session mit Logging, einer schreibenden View und gespeicherter Ausgabe „seen-42“
- **WHEN** die View die Größe ändert und tmux den Bildschirm neu in die PTY schreibt
- **THEN** entsteht kein neuer Verlaufseintrag, und die View erhält das Neuzeichnen als Ausgabe

#### Scenario: Fenster ziehen

- **GIVEN** eine Session, deren Neuzeichnen nach einer Größenänderung noch läuft
- **WHEN** zwei weitere Größenänderungen folgen und tmux jedes Mal neu zeichnet
- **THEN** läuft genau ein weiteres Neuzeichnen danach, und keine dieser Ausgaben wird gespeichert

#### Scenario: Ausgabe nach der Größenänderung

- **GIVEN** eine Session, deren Neuzeichnen nach einer Größenänderung beendet ist
- **WHEN** das Programm „after-2“ ausgibt
- **THEN** speichert der Verlauf „after-2“

#### Scenario: Gleiche Größe

- **GIVEN** eine Session mit PTY und der Größe 80×24
- **WHEN** die schreibende View die Größe 80×24 sendet
- **THEN** fordert die Registry kein Neuzeichnen an, und die folgende Ausgabe wird gespeichert

#### Scenario: Session ohne PTY

- **GIVEN** eine beendete Session (`Exited`) mit schreibender View
- **WHEN** die View die Größe 120×40 sendet
- **THEN** fordert die Registry kein Neuzeichnen an und speichert die Größe 120×40

#### Scenario: Gescheitertes Neuzeichnen nach Größenänderung

- **GIVEN** eine Session, deren Neuzeichnen nach einer Größenänderung zweimal scheitert
- **WHEN** danach ein Neuzeichnen von tmux eintrifft
- **THEN** speichert der Verlauf es

### Requirement: Grenze der Kennzeichnung bei Größenänderungen

Eine Größenänderung ohne laufende Kette beginnt eine; Grenze 1 s danach. Sie endet 1 s nach ihrer letzten Größenänderung, frühestens an der Grenze. Die Kennzeichnung ihrer Neuzeichnen SHALL an der Grenze enden; Ausgabe bis dahin MUST im Verlauf fehlen. Danach SHALL die Registry für die Kette kein Neuzeichnen und kein gekennzeichnetes Folge-Neuzeichnen mehr starten, der Verlauf MUST wieder speichern, auch doppelte Neuzeichnen. Neuzeichnen beim Anhängen MUST gekennzeichnet bleiben.

#### Scenario: Fenster lange ziehen

- **GIVEN** eine WSL-Session, deren schreibende View 2 s lang alle 70 ms die Größe ändert, während ein Programm ausgibt
- **WHEN** die Ausgabe in der ersten Sekunde und danach eintrifft
- **THEN** fehlt die Ausgabe der ersten Sekunde im Verlauf, die spätere Ausgabe wird gespeichert, auch wenn tmux den Bildschirm dabei neu zeichnet

#### Scenario: Neue Kette nach einer Pause

- **GIVEN** eine Kette, deren Grenze abgelaufen ist, und seit ihrer letzten Größenänderung mehr als 1 s
- **WHEN** die View die Größe ändert und tmux neu zeichnet
- **THEN** beginnt eine neue Kette, und der Verlauf speichert dieses Neuzeichnen nicht

#### Scenario: Anhängen bleibt unberührt

- **GIVEN** eine Kette, deren Grenze in 150 ms abläuft, und eine zweite View, die mit Snapshot des Backends anhängt
- **WHEN** das Neuzeichnen für das Anhängen über die Grenze hinaus läuft oder als Folge-Neuzeichnen nach dem Aufruf der Größenänderung startet
- **THEN** speichert der Verlauf weder dieses Neuzeichnen noch die Ausgabe während seines Aufrufs

### Requirement: Trefferzeilen wie im Terminal

Die Suche SHALL jede Zeile so zusammensetzen, wie das Terminal sie anzeigte: Zeichen überschreiben am Cursor, Backspace setzt ihn um einen Codepoint zurück (nie vor den Anfang), `ESC[K`/`ESC[0K`/`ESC[J` löschen ab dem Cursor, `ESC[1K` ersetzt den Anfang bis zum Cursor durch Leerzeichen, `ESC[2K` leert die Zeile (Cursor auf 0), `\r` setzt ihn an den Anfang, `\n` beendet die Zeile. Zeile und Position eines Treffers MUST aus dieser fertigen Zeile stammen. Andere Sequenzen SHALL nur entfernt werden.

#### Scenario: Tippfehler mit Backspace

- **GIVEN** ein Verlauf mit der Ausgabe `echo Apfelk`, `i`, `u`, `c`, `h`, viermal Backspace mit `ESC[K`, dann `u`, `c`, `h`, `e`, `n`
- **WHEN** der Client „echo“ sucht
- **THEN** zeigt der Treffer „echo Apfelkuchen“ mit der Position des Treffers in dieser Zeile, und eine Suche nach „kiu“ findet nichts

#### Scenario: Überschreiben mit Wagenrücklauf

- **GIVEN** die Ausgabe `10%\r20%\r100%\r\n`
- **WHEN** der Client „%“ sucht
- **THEN** liefert der Core genau eine Zeile „100%“

#### Scenario: Zeile leeren und neu schreiben

- **GIVEN** die Ausgabe `lange Zeile\r\x1b[2Kkurz\r\n`
- **WHEN** der Client „ge Zeile“ sucht
- **THEN** findet er nichts, und „kurz“ liefert genau die Zeile „kurz“; `ESC[2K` setzt den Cursor auf 0, die Lücke vor einem Cursor jenseits davon wird nicht mit Leerzeichen gefüllt

#### Scenario: Backspace über Eintragsgrenzen

- **GIVEN** ein Eintrag `abcx`, im nächsten Eintrag ein Backspace, im dritten `d` und ein Zeilenende
- **WHEN** der Client „abcd“ sucht
- **THEN** liefert der Core diese Zeile als Treffer, und „abcx“ findet nichts; am Anfang einer Zeile bleibt der Cursor bei 0

#### Scenario: Emoji

- **GIVEN** die Ausgabe `a😀b` mit drei Backspace und `X`
- **WHEN** der Client „X“ sucht
- **THEN** lautet die Zeile „X😀b“, und keine Zeile enthält ein einzelnes Surrogat: Backspace und Überschreiben arbeiten mit Codepoints

#### Scenario: Grenzen des Zeilenmodells

- **GIVEN** eine Zeile über 4096 Zeichen, deren Kopf beim Zuschneiden schon durchsucht wurde, und breite Zeichen (CJK, zwei Spalten)
- **WHEN** die Zeile danach mit `\r` oder Backspace geändert wird
- **THEN** bleibt ein Treffer im schon durchsuchten Kopf bestehen, und der Cursor behält seine Stelle im Rest der Zeile; Backspace zählt ein breites Zeichen als eine Spalte, die Spaltenbreite wird nicht nachgebildet

### Requirement: Schreibfehler einmal je Fehlerstrecke melden

Scheitert das Schreiben des Verlaufs einer Session (Platte voll, Ordner schreibgeschützt), SHALL der Core den Fehler einmal melden und weitere Fehler dieser Session nicht melden, bis wieder ein Schreiben gelingt; danach MUST der nächste Fehler wieder gemeldet werden. Die verworfenen Einträge MUST weiter vollständig gezählt werden.

#### Scenario: Anhaltender Schreibfehler

- **GIVEN** ein Datenverzeichnis, in dem `history/` nicht angelegt werden kann
- **WHEN** eine Session fünfmal Ausgabe speichern will und eine zweite Session einmal
- **THEN** wird je Session ein Fehler gemeldet und fünf Einträge der ersten Session zählen als verworfen

#### Scenario: Schreiben gelingt wieder

- **GIVEN** eine Session, deren Schreibfehler gemeldet wurde
- **WHEN** `history/` wieder angelegt werden kann, ein Schreiben gelingt und danach erneut eines scheitert
- **THEN** steht die Ausgabe des gelungenen Schreibens im Verlauf und der neue Fehler wird wieder gemeldet
