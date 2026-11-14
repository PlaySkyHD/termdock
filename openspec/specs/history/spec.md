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
