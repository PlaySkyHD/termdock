# Tasks

## 1. Store

- [x] 1.1 Test und Umsetzung: Format, Pfad `history/<id>/a.log`, Teilen langer Ausgabe, Ablehnen unsicherer IDs (`history-store.test.ts`, `history-store.ts`)
- [x] 1.2 Test und Umsetzung: Segmentwechsel, Verbrauch nie über dem Limit, mindestens Limit / 2 der jüngsten Ausgabe, Reihenfolge alt nach neu, Weiterschreiben nach Neustart (`history-store.test.ts`)
- [x] 1.3 Test und Umsetzung: abgeschnittener, halber und unplausibler letzter Eintrag werden übersprungen, Kürzen vor dem Weiterschreiben (`history-store.test.ts`)
- [x] 1.4 Test und Umsetzung: begrenzte Warteschlange verwirft die ältesten Einträge und zählt, Schreibfehler werfen nicht (`history-store.test.ts`)

## 2. Anbindung

- [x] 2.1 Test und Umsetzung: `recordHistory` schreibt nur bei `loggingEnabled`, Abschalten stoppt das Schreiben und lässt Daten stehen, Standard aus `defaultLoggingEnabled` (`history-store.test.ts`, `registry.ts`)
- [x] 2.2 Test und Umsetzung: Core-Start verdrahtet Store und Recorder, `close()` schreibt Wartendes (`run-core.test.ts`, `run-core.ts`)

## 3. Last

- [x] 3.1 Test: 50 MiB durch die Registry mit `FakeBackend`, Limit hält, jüngste Ausgabe erhalten, Ausgabe wartet nicht (`history-store.test.ts`)
- [x] 3.2 Test: 50 MiB Programmausgabe über WSL, Limit hält, PTY fließt weiter (`e2e.wsl.test.ts`, `TERMDOCK_WSL_TESTS=1`)
