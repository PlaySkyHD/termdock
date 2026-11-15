# Proposal

## Why

Jeder UI-Agent musste für eine Szene den ganzen Screenshot-Lauf starten (mehrere Minuten) und scheiterte mehrfach an fremden Szenen (#104, #97). Ein Filter nach Szenengruppen verkürzt den Lauf und isoliert ihn von fremden Fehlern (Issue #112).

## What Changes

- `--scenes <gruppe,…>` zu `--screenshot <dir>`: `scenario`, `sidebar`, `tabs`, `snap`, `restore`, `quit`, `search`, `settings`. Ohne die Option laufen alle Gruppen wie bisher, in fester Reihenfolge.
- Ein unbekannter Name oder eine leere Liste beendet die App vor dem Start des Cores mit Code 1 und nennt die gültigen Namen.
- Jede Gruppe bringt ihren Aufbau mit: `sidebar`, `restore` und `quit` legen die fünf Sessions des ersten Abschnitts an, `restore` zusätzlich Editor, Shell und Misc; `tabs`, `snap`, `search` und `settings` legen ihre eigenen an. Bildnamen und Inhalt der Bilder bleiben.
- `AGENTS.md` und `docs/agent-lessons-learned.md` nennen die Option.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: neue Anforderung „Screenshot-Modus wählt Szenengruppen“ (ADDED).

## Impact

- Nur `apps/desktop` (`screenshot.ts`, `screenshot-scenario.ts`, `screenshot-restore.ts`, `main.ts`) und Doku. Kein Vertragswechsel, keine neue Dependency, keine Änderung der Aufnahmen eines vollen Laufs.
- Non-Goals: Filter auf einzelne Szenen innerhalb einer Gruppe; Umbenennen der Bilder (#117).
- Security: keine neue Angriffsfläche; die Namen werden gegen eine feste Liste geprüft, nichts davon erreicht eine Shell.
