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

Fordert die Registry nach dem Anhängen einer View ein Neuzeichnen an, SHALL sie die Ausgabe der PTY, die ein Backend-Aufruf dafür neu zeichnet, während dieses Aufrufs und höchstens 2 s je Aufruf als Neuzeichnen kennzeichnen; ein gescheiterter Aufruf beendet die Kennzeichnung sofort. Der Verlauf MUST solche Ausgabe nicht speichern; Views MUST sie unverändert erhalten. Alle übrige Ausgabe SHALL der Verlauf speichern, auch Neuzeichnen, das tmux von selbst oder beim Anbinden einer PTY auslöst.

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
