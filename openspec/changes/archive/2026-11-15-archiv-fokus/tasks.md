# Tasks

## 1. Fokusplan

- [x] 1.1 Test und Umsetzung: `focusReady` wartet, bis eine Session im Zustand `Archived` ist, und ist bereit, wenn sie fehlt (`renderer/sidebar-model.test.ts`, `focusReady`)

## 2. Sidebar

- [x] 2.1 Umsetzung: `archive()` setzt den Fokus auf die archivierte Zeile und klappt das Archiv auf; Prüfung durch die Screenshot-Szene (Archivieren per Tastatur bei zugeklapptem Archiv, `document.activeElement` auf der Zeile im Archiv, Code 1 bei Abweichung, `main/screenshot-sidebar.ts`)
