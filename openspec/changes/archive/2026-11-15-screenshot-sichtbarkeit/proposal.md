# Proposal

## Why

In PR #115 lag die Fehlermeldung der Szene `65-settings-profile-error.png` unterhalb des sichtbaren Bereichs des scrollbaren Editors. Die Szene lief grün, weil `capture` nur prüft, dass die Datei geschrieben wird (#116).

## What Changes

- Die vier `capture`-Helfer der Szenen werden zu einem gemeinsamen `captureWindow` zusammengeführt.
- `capture(name, { visible: "<selector>" })` prüft vor der Aufnahme, dass das Element existiert und sein Rechteck vollständig im nächsten scrollbaren Vorfahren und im Fenster liegt. Sonst endet der Lauf mit Code 1 und nennt Szene und Selektor.
- Eingesetzt in `65-settings-profile-error`, `54-snap-menu`, `84-context-menu`, `85-delete-confirm` und `24-quit-dialog`.
- Neue Szenen mit Fehler, Menü oder Dialog brauchen den Selektor (Review-Regel).

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: neue Anforderung zur Sichtbarkeitsprüfung der Szenen.

## Impact

Nur `apps/desktop` (Main: `screenshot-visible.ts`, `screenshot-page.ts` und die Szenendateien) und `.agents/instructions/code-review.instructions.md`.
