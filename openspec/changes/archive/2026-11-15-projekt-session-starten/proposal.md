# Proposal

## Why

Ein Projekt in der Sidebar (#63) lässt sich nur umbenennen und löschen: Klick öffnet nur das Menü, und es gibt keinen Weg, eine Session im Projektverzeichnis zu starten. Für den Nutzer ist unklar, wozu ein Projekt da ist (#104, Befund des manuellen Tests von Welle 2).

## What Changes

- Klick und Enter auf eine Projektzeile starten eine neue Session im Projekt und öffnen sie wie eine neue Session im aktiven Tab; Strg+Klick öffnet einen neuen Tab, Umschalt+Klick teilt das aktive Pane.
- Das Menü eines Projekts (Rechtsklick, Menütaste, Umschalt+F10) bekommt als ersten Eintrag „Neue Session hier“, danach Umbenennen und Löschen.
- Die Session entsteht mit `session.create`: Name des Projekts, Workspace des Projekts, `launch` mit Backend, Distro und Pfad des Projekts als Arbeitsverzeichnis, ohne Shell, Befehl und Umgebung (Standard-Shell).
- Ein Fehler des Core (etwa Backend nicht verfügbar) erscheint in der Statusleiste, wie bei anderen Aktionen der Sidebar ohne Dialog. Ein zweiter Start desselben Projekts, solange der erste läuft, wird abgewiesen.
- Screenshot-Szene: Projektmenü mit „Neue Session hier“ und die gestartete Session im Projektpfad.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: „Kontextmenü als Tastatur-Alternative“ geändert (Menü des Projekts); neu „Session im Projekt starten“ und „Screenshot-Szene für Projekt-Sessions“.

## Impact

- Nur `apps/desktop` (Renderer, Screenshot-Szene). Kein Vertragswechsel: `packages/protocol` und `packages/core` bleiben unverändert.
- Non-Goals: Sessions unter ihrem Projekt gruppieren (braucht ein `projectId` an `SessionInfo` und `session.create`, also eine Protokolländerung), Startprofile je Projekt (#64).
- Security: Der Pfad geht als Feld von `LaunchSpec` an den Core, der ihn als Argument-Array an `wsl.exe --cd` übergibt; keine Shell-Strings im Renderer.
- Breaking Changes: Klick auf ein Projekt öffnet nicht mehr das Menü (Rechtsklick, Menütaste und Umschalt+F10 bleiben).
