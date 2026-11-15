# Tasks

## 1. Prüfung

- [x] 1.1 Test und Umsetzung: `isRectVisible` (ganz sichtbar, unten abgeschnitten, ganz außerhalb, ohne scrollbaren Container, Rundung) und `assertVisible` mit Szenenname und Selektor in der Meldung (`screenshot-visible.test.ts`, `screenshot-visible.ts`)

## 2. Szenen

- [x] 2.1 `captureWindow` mit Option `visible` und Umstellung der vier Helfer (`screenshot-page.ts`, `-scenario`, `-search`, `-restore`; geprüft durch `npm run screenshot -w apps/desktop`, Exit-Code 0)
- [x] 2.2 Selektoren in `65-settings-profile-error`, `54-snap-menu`, `84-context-menu`, `85-delete-confirm`, `24-quit-dialog` (geprüft durch den Lauf, ein falscher Selektor lässt ihn mit Code 1 enden)

## 3. Review-Regel

- [x] 3.1 `code-review.instructions.md`: Szene mit Fehler, Menü oder Dialog braucht den Selektor (geprüft durch Lesen des Diffs)
