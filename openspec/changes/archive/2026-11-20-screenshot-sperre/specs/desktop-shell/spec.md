## ADDED Requirements

### Requirement: Screenshot-Läufe laufen rechnerweit nacheinander

Vor dem Start seines isolierten Cores SHALL ein Screenshot-Lauf die Datei `termdock-screenshot.lock` im Temp-Verzeichnis exklusiv anlegen und seine PID hineinschreiben. Ist sie belegt und lebt ihr Prozess, SHALL er warten und `waiting for screenshot run <pid>` loggen, höchstens 15 min, sonst ohne Core mit Code 1 enden. Eine Sperre eines beendeten Prozesses SHALL als frei gelten. Am Ende SHALL er nur die eigene Sperre entfernen. Das Warten SHALL nicht in das Laufzeitlimit zählen.

#### Scenario: Zweiter Lauf wartet

- **GIVEN** ein Screenshot-Lauf mit PID 100 hält die Sperre
- **WHEN** ein zweiter Screenshot-Lauf startet
- **THEN** loggt er `waiting for screenshot run 100`, startet keinen Core, solange die Sperre gehalten wird, und beginnt seine Szenen erst, wenn der erste Lauf die Sperre entfernt hat

#### Scenario: Verwaiste Sperre

- **GIVEN** die Sperrdatei enthält die PID eines beendeten Prozesses
- **WHEN** ein Screenshot-Lauf startet
- **THEN** ersetzt er die Sperre durch seine eigene und läuft ohne zu warten

#### Scenario: Zeitlimit des Wartens

- **GIVEN** ein lebender Lauf hält die Sperre länger als 15 min
- **WHEN** der wartende Lauf sein Zeitlimit erreicht
- **THEN** endet er mit Code 1, ohne einen Core gestartet zu haben, und lässt die fremde Sperre liegen

#### Scenario: Freigabe am Ende

- **GIVEN** ein Screenshot-Lauf hält die Sperre
- **WHEN** er endet, mit Code 0 oder 1, auch weil das Verbinden mit seinem Core scheitert
- **THEN** entfernt er die Sperrdatei, aber nur, wenn sie noch seine PID enthält
