# Tasks

## 1. Handles

- [x] 1.1 Test und Umsetzung: 20 PTYs mit `cmd /c echo x` lassen den Core um weniger als 50 Handles wachsen, ohne Fix 60 (`backend/wsl/conpty-handles.test.ts`)
- [x] 1.2 Test und Umsetzung: Nach einer gescheiterten Weiterleitung hält der Leser nur noch die Pipe der anderen PTY (`backend/wsl/conout-reader.test.ts`, „ends only the PTY whose relay connection fails“)

## 2. Dokumentation

- [x] 2.1 Grenze zum HPCON in ADR 0008; geprüft durch `npm run format:check` und den Review
