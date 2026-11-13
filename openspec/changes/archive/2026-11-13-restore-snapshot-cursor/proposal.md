# Proposal

## Why

Das WSL-Backend ermittelt beim Snapshot die Cursorposition, der Core verwirft sie aber: Der Snapshot einer neuen View enthält nur den Bildschirminhalt. Die Desktop-App muss deshalb Leerzeilen am Ende abschneiden, und bei Vollbildprogrammen (vim, htop) steht der Cursor bis zum nächsten Neuzeichnen falsch (Issue #32). ADR 0003 verspricht „Snapshot plus Cursorposition“.

## What Changes

- `parseSnapshot` im WSL-Backend hängt an den Bildschirm `ESC[0m`, die Cursor-Positionierung `ESC[<y+1>;<x+1>H` und `ESC[?25h` (verborgener Cursor: `ESC[?25l`). Bildschirm, Cursor und Sichtbarkeit kommen aus einem tmux-Aufruf (`#{cursor_flag}`). Die Registry hängt Ausgabe der Aufnahme dahinter, der Cursor bleibt damit auch bei nachfolgender Ausgabe richtig.
- Keine Protokolländerung: Die Positionierung steckt in den Nutzdaten. Das Feld `cursor` bleibt, wird aber weggelassen, wenn Ausgabe angehängt wurde (es gälte dann nicht mehr).
- Der Windows-Pfad (Rohpuffer, kein Cursor) bleibt unverändert.
- ADR 0003 wird präzisiert.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `session-lifecycle`: Anforderung „Snapshot für neue Views“ (Cursor-Positionierung in den Nutzdaten).

## Impact

- `packages/core/src/backend/wsl/commands.ts` (`snapshotArgs`, `parseSnapshot`), Tests in `commands.test.ts`, `registry.test.ts` und im WSL-Integrationstest. `registry.ts` bleibt.
- Dependencies: keine neuen. Non-Goals: `apps/desktop` (das Abschneiden der Leerzeilen entfällt später), `packages/protocol`.
- Security: keine neuen Eingänge; die Sequenz entsteht aus zwei Ganzzahlen des Backends.
