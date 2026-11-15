# Proposal

## Why

Ändert die schreibende View die Größe einer Session (Fenster ziehen, Tab-Wechsel, Panes, Dialoge), ruft die Registry `pty.resize` auf. tmux bekommt SIGWINCH und schreibt den ganzen Bildschirm noch einmal in die PTY. Diese Bytes sind nicht gekennzeichnet; `recordHistory` speichert sie wie Programmausgabe (Issue #99, Lücke in #88). Belegt im Verlauf einer echten Session: dieselbe Bildschirmseite steht dort rund zwei Dutzend Mal, jeweils direkt hinter `ESC[1;<n>r` (tmux setzt nach der Größenänderung die Scrollregion zurück). Wiederholungen verdrängen echte Ausgabe aus dem Ringpuffer und erscheinen bei der Wiedergabe mehrfach. Ein WSL-Test bestätigt es: nach `session.resize` wächst der Verlauf um den neu gezeichneten Bildschirm.

## What Changes

- `SessionRegistry.resize` fordert vor `pty.resize` ein Neuzeichnen an (`requestRedraw`), wenn sich die Größe einer Session mit PTY ändert. Die Ausgabe der PTY ist während dieses Aufrufs als Neuzeichnen gekennzeichnet (`fromRedraw`, #88); das Neuzeichnen von tmux nach der Größenänderung fällt in diesen Lauf und wird nicht gespeichert.
- Mehrere Größenänderungen hintereinander ergeben wie beim Anhängen höchstens einen laufenden und einen folgenden Aufruf.
- Eine Größenänderung auf die bisherige Größe fordert kein Neuzeichnen an (tmux zeichnet dann nicht neu, gemessen).
- Spec `history`: neue Anforderung „Neuzeichnen nach Größenänderung nicht speichern“, die Anforderung zum Anhängen nimmt die Ausnahme auf.
- ADR 0003 und 0004 nennen die Regel.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `history`: Neuzeichnen nach einer Größenänderung wird nicht gespeichert.

## Impact

- `packages/core`: `session/registry.ts` (`resize`), Tests in `session/registry.test.ts` und `e2e.wsl.test.ts`; `docs/adr/0003-backends-und-terminal-datenfluss.md`, `docs/adr/0004-speicher-und-verlaufsformat.md`.
- IPC, Protokoll, Datenmodell, Verlaufsformat und Desktop: unverändert.
- Laufzeit: je Folge von Größenänderungen ein bis zwei zusätzliche `refresh-client`-Läufe (je zwei `wsl.exe`-Aufrufe) pro Session; höchstens einer läuft gleichzeitig.
- Non-Goals: schon gespeicherte Wiederholungen entfernen; Neuzeichnen, das tmux ohne Anlass des Core auslöst; Verlauf per `pipe-pane` (ADR-Frage für später); Suche (`history-search.ts`).
- Security: keine neuen Befehle; `refresh-client` läuft wie beim Anhängen als Argument-Array.
- Breaking Changes: keine. Dependencies: keine neuen.
