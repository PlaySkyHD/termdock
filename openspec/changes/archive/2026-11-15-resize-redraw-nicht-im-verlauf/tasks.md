# Tasks

## 1. Registry

- [x] 1.1 Test und Umsetzung: `resize` mit neuer Größe fordert vor `pty.resize` ein Neuzeichnen an; das Neuzeichnen von tmux danach trägt `fromRedraw`, Ausgabe nach dem Lauf nicht (`registry.test.ts` „flags the repaint of tmux after a resize …“, `registry.ts`)
- [x] 1.2 Test: Größenänderungen während eines Laufs ergeben genau einen folgenden Lauf, alle Neuzeichnen sind gekennzeichnet (`registry.test.ts` „merges resizes while a redraw runs …“)
- [x] 1.3 Test: Größenänderung auf die bisherige Größe fordert kein Neuzeichnen an (`registry.test.ts` „requests no redraw for a resize to the current size“)

## 2. Verlauf über WSL

- [x] 2.1 Test: Über WSL erzeugen drei Größenänderungen hintereinander keinen neuen Verlaufsinhalt, spätere Ausgabe wird gespeichert (`e2e.wsl.test.ts` „does not store the repaint of tmux after a resize“, `TERMDOCK_WSL_TESTS=1`)

## 3. Dokumentation

- [x] 3.1 ADR 0003 (Größe) und ADR 0004 (Verlauf) nennen die Regel; Spec `history` (Prüfung: `bash scripts/openspec-check.sh --specs`)
