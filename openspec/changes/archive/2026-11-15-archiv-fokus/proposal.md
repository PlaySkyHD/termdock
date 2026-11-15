# Proposal

## Why

Nach erfolgreichem Archivieren (Menü, Tastatur, Ziehen aufs Archiv) setzt `Sidebar.tsx` (`archive()`) den Fokus auf den Knopf „+“ (`SIDEBAR_FOCUS`). Die Session besteht aber weiter, nur im Archiv. Die Spec „Fokus nach der Aktion“ verlangt die auslösende Zeile und den Knopf nur dort, wo es die Zeile nicht mehr gibt (Issue #97). Ein Tastaturnutzer verliert so seine Stelle in der Liste.

## What Changes

- Nach dem Archivieren steht der Fokus auf der archivierten Zeile im Archiv. Der Fokusplan wartet, bis das Ereignis des Core die Session ins Archiv gesetzt hat (wie beim Verschieben, `focusReady`).
- Ist das Archiv zugeklappt, klappt es dafür auf, damit die Zeile sichtbar ist.
- Abbrechen und Esc im Bestätigungsdialog geben den Fokus wie bisher an die auslösende Zeile; ein Fehler des Core lässt den Dialog offen.
- Screenshot-Szene: Archivieren per Tastatur bei zugeklapptem Archiv, Prüfung von `document.activeElement`.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: neue Anforderung „Fokus nach dem Archivieren“ (ADDED).

## Impact

- Nur `apps/desktop` (`Sidebar.tsx`, `sidebar-model.ts`, Test, Screenshot-Szene). Kein Vertragswechsel, keine neue Dependency.
- Sichtbare UI-Änderung (Fokusring, Archiv klappt auf): Screenshots im PR.
- Security: keine Auswirkung.
