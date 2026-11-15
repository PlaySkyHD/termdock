# Tasks

## 1. Modell und Menü

- [x] 1.1 Test und Umsetzung: `projectSessionParams` (Name, Workspace, Backend, Distro nur wenn gesetzt, `cwd` = Pfad, keine Shell) und `projectMenu` mit „Neue Session hier“ zuerst (`renderer/sidebar-model.test.ts`, `sidebar-model.ts`)

## 2. Start

- [x] 2.1 Test und Umsetzung: `startProjectSession` legt die Session mit den Parametern des Projekts an und öffnet sie je nach Modus (Tab, neuer Tab, Split); Fehler des Core als Hinweis; zweiter Start während des ersten wird abgewiesen (`renderer/commands.test.ts`, `commands.ts`)
- [x] 2.2 Umsetzung: Klick auf die Projektzeile mit Strg und Umschalt, Menüeintrag, Fokus; geprüft durch die Szene aus 3.1 (`Sidebar.tsx`, `App.tsx`)

## 3. Screenshots

- [x] 3.1 Szene: Projektmenü mit „Neue Session hier“, Klick startet eine Session im Pfad des Projekts (Prüfung über den Core und die Ausgabe des Terminals); die Ablehnung des Core ist durch `commands.test.ts` geprüft (der Core lehnt einen fehlenden Pfad nicht ab); Lauf endet mit Code 1, wenn es nicht eintritt (`main/screenshot-sidebar.ts`)
