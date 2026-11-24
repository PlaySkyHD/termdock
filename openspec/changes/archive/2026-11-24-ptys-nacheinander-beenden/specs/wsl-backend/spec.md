## ADDED Requirements

### Requirement: PTYs enden nacheinander

Der Core SHALL die PTYs eines Prozesses nacheinander schließen. Die nächste schließt er erst, wenn der Prozess der vorigen geendet hat, spätestens nach 2 s. Dann beendet er den Prozess selbst und wartet noch höchstens 0,5 s. Das gilt für jeden Abbau, auch nach einem Absturz des Lesers. Vor seinem Ende MUST der Core auf alle begonnenen Schließvorgänge warten, höchstens 15 s.

#### Scenario: Abbau mit vielen PTYs

- **GIVEN** eine Registry mit 20 Sessions, deren PTYs `cmd.exe` über den Pfad des Core ausführen
- **WHEN** die Registry abgebaut wird
- **THEN** läuft direkt danach noch jeder Prozess, nach dem Warten auf die Schlange ist jeder beendet, und das dauert weniger als 15 s

#### Scenario: Reproduktion

- **GIVEN** Windows ohne WSL und ein gebauter Core
- **WHEN** `node scripts/pty-shutdown-repro.mjs` 50 Läufe mit je 20 PTYs ausführt
- **THEN** endet jeder Lauf mit Code 0

#### Scenario: PTY vor ihrer ersten Ausgabe

- **GIVEN** eine PTY, die noch nichts ausgegeben hat, sodass node-pty sein `kill` zurückstellt
- **WHEN** der Core sie schließt
- **THEN** ist ihr Prozess nach weniger als 5 s beendet, und die Schlange geht weiter

#### Scenario: Ende des Core wartet

- **GIVEN** ein WSL-Backend, dessen PTYs noch schließen
- **WHEN** es abgebaut wird
- **THEN** endet der Abbau erst, wenn die Schlange leer ist
