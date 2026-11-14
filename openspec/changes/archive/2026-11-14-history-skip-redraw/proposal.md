# Proposal

## Why

Beim Anhängen einer View (Tab-Wechsel, Neustart der Oberfläche, Wiederanbinden des Core) fordert die Registry ein Neuzeichnen an (`requestRedraw`, Issue #34): tmux schreibt den ganzen Bildschirm noch einmal in die PTY. `recordHistory` (#59) speichert diese Bytes wie Programmausgabe. Die Suche (#62) fände sichtbare Zeilen dann mehrfach, und jede Wiederholung verdrängt echte Ausgabe aus dem Ringpuffer. Spec `history` führt das bisher als bekannte Grenze (Issue #88).

## What Changes

- `OutputEvent` der Registry bekommt das Feld `fromRedraw`. Es ist wahr für jede Ausgabe, die eintrifft, während ein angefordertes Neuzeichnen der Session läuft (vom Anfordern bis zum Ende des Neuzeichnens samt Wiederholung und zusammengefasstem Folge-Neuzeichnen), sonst falsch.
- `recordHistory` speichert Ausgabe mit `fromRedraw` nicht. Views bekommen sie unverändert.
- Spec `history`: Die bekannte Grenze „Neuzeichnen beim Anhängen“ wird durch eine Anforderung ersetzt.
- ADR 0004 nennt die Regel im Abschnitt Verlauf.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `history`: Ausgabe eines angeforderten Neuzeichnens wird nicht gespeichert.

## Impact

- Phase 3 (Kapitel 12, Verlauf und Suche, P3-7), Folge von #59, vor #62.
- `packages/core`: `session/registry.ts` (nur `OutputEvent` und die Stelle, an der Ausgabe gemeldet wird), `storage/history-recorder.ts`; Tests in `session/registry.test.ts` und `storage/history-store.test.ts`. `docs/adr/0004-speicher-und-verlaufsformat.md`.
- IPC: unverändert. `fromRedraw` bleibt Core-intern, `session.output` und `PROTOCOL_VERSION` ändern sich nicht. Datenmodell und Verlaufsformat unverändert.
- Non-Goals: Neuzeichnen, das tmux von selbst auslöst (Wechsel des Vordergrundprogramms, Größenänderung durch den Schreiber), bleibt im Verlauf; Entfernen schon gespeicherter Wiederholungen; Suche (#62); Desktop.
- Security: keine Auswirkung. Es werden keine neuen Befehle an `wsl.exe` oder tmux geschickt.
- Breaking Changes: keine. `OutputEvent` ist Core-intern; `HistorySource` bekommt ein optionales Feld.
- Dependencies: keine neuen.
