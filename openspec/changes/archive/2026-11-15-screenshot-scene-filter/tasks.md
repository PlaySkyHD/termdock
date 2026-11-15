# Tasks

## 1. Option

- [x] 1.1 Test und Umsetzung: `screenshotScenes` liefert ohne Option alle Gruppen, mit Liste die genannten in fester Reihenfolge, wirft bei unbekanntem Namen (mit den gültigen Namen) und bei leerer Liste (`screenshot.test.ts`)
- [x] 1.2 `main.ts` prüft die Option vor dem Start des Cores und endet bei Fehler mit Code 1 (Einzellauf mit `--scenes search,nope`: Code 1, Meldung nennt die gültigen Namen)

## 2. Gruppen für sich

- [x] 2.1 `runScenario` spielt nur die gewählten Gruppen; `restore` legt Editor, Shell und Misc selbst an (Einzellauf je Gruppe: `npm run screenshot -w apps/desktop -- <dir> --scenes <gruppe>` endet mit Code 0 und enthält die Bilder der Gruppe; voller Lauf ohne Option endet mit Code 0)

## 3. Doku

- [x] 3.1 `AGENTS.md` (Befehle) und `docs/agent-lessons-learned.md` nennen `--scenes` (Prüfung: `npm run format:check`)
