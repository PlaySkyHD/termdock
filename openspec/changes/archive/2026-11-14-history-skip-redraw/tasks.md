# Tasks

## 1. Registry

- [x] 1.1 Test und Umsetzung: `OutputEvent.fromRedraw` ist wahr, solange ein angefordertes Neuzeichnen läuft (auch Wiederholung und Folge-Neuzeichnen), sonst falsch; Views bekommen die Ausgabe weiter (`registry.test.ts`, `registry.ts`)
- [x] 1.2 Test: Nach einem zweimal gescheiterten Neuzeichnen ist `fromRedraw` wieder falsch (`registry.test.ts`)

## 2. Verlauf

- [x] 2.1 Test und Umsetzung: `recordHistory` speichert Ausgabe mit `fromRedraw` nicht (`history-store.test.ts`, `history-recorder.ts`)
- [x] 2.2 Test: Zweite View hängt an, das Neuzeichnen erzeugt keinen Verlaufseintrag, Ausgabe davor und danach steht im Verlauf (`history-store.test.ts`, Registry mit `FakeBackend`)

- [x] 2.3 Test: Über WSL erzeugt das Anhängen einer zweiten View keinen neuen Verlaufsinhalt, spätere Ausgabe wird gespeichert (`e2e.wsl.test.ts`, `TERMDOCK_WSL_TESTS=1`)

## 3. Dokumentation

- [x] 3.1 ADR 0004 (Abschnitt Verlauf) nennt die Regel; Spec `history` ersetzt die bekannte Grenze (Prüfung: `bash scripts/openspec-check.sh --specs`)
