# Proposal

## Why

Phase 2 (Kapitel 12, „Desktop-Erlebnis“) verlangt Navigation per Tastenkürzel und eine funktionierende Zwischenablage (Issue #28; Risiko „Rich TUI: Clipboard“, Kapitel 11). Nach #26 und #27 bedient man Tabs, Panes und Sidebar nur mit der Maus. Außerdem fehlen Kopieren und Einfügen, die mit Umlauten, mehrzeiligem Text und Bracketed Paste in der Shell und in TUIs funktionieren müssen.

## What Changes

- **Zentrale Keymap** (`keymap.ts`): Befehl → Kürzel mit einer Standardbelegung, plus Auflösung eines Tastenereignisses zu einem Befehl. Standard: `Ctrl+Shift+T` neue Session, `Ctrl+Shift+W` Tab schließen, `Ctrl+Tab` / `Ctrl+Shift+Tab` und `Ctrl+1…9` Tabs, `Ctrl+Shift+D` / `Ctrl+Shift+E` teilen, `Alt+Pfeiltasten` Pane-Fokus, `Ctrl+Shift+B` Sidebar, `Ctrl+Shift+N` neues Fenster (Menü), `Ctrl+Shift+C` / `Ctrl+Shift+V` Kopieren und Einfügen, `Ctrl+Shift+H` Übersicht der Kürzel. Kein Kürzel ist `Ctrl+<Buchstabe>` ohne Shift.
- **Abfangen vor xterm.js:** `attachCustomKeyEventHandler` im `TerminalController` führt gebundene Tasten als Befehl aus und hält sie von der Shell fern; alle anderen Tasten gehen unverändert an xterm.js. Ein Fenster-Listener deckt den Fokus außerhalb des Terminals ab.
- **Befehle** (`commands.ts`): laufen über die bestehenden Store-Aktionen; Pane-Fokus nach Geometrie (`pane-focus.ts`).
- **Zwischenablage:** `Ctrl+Shift+C` kopiert die Auswahl, `Ctrl+Shift+V` und Rechtsklick fügen ein, über `navigator.clipboard` (kein neuer Brückenaufruf). Einfügen nur in der schreibenden View; `Terminal.paste` von xterm.js wandelt Zeilenumbrüche um und setzt Bracketed Paste, wenn die Anwendung es angefordert hat.
- **Übersicht:** kleiner Dialog (`ShortcutsDialog`) aus der Keymap, per Tab-Leiste oder `Ctrl+Shift+H`.
- **Screenshot-Modus:** Szenen mit echten Tastenereignissen (Ctrl+C, Übersicht, Einfügen, Kopieren, Teilen, Fokus, Sidebar, Tab schließen).
- ADR 0006 ergänzt.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: ADDED Zentrale Keymap, Tastenkürzel vor xterm.js, Zwischenablage nur in der schreibenden View, Übersicht der Kürzel, Screenshot-Szenen.

## Impact

- Geändert: `apps/desktop/src/renderer/**` (neu: `keymap.ts`, `commands.ts`, `pane-focus.ts`, `ShortcutsDialog.tsx`; geändert: `terminal-controller.ts`, `TerminalView.tsx`, `PaneTree.tsx`, `TabBar.tsx`, `App.tsx`, `styles.css`), `apps/desktop/src/main/screenshot-scenario.ts`, `docs/adr/0006-desktop-architektur.md`.
- IPC-Methoden und Brückenaufrufe: keine neuen. Datenmodelle unverändert.
- Dependencies: keine neuen.
- Non-Goals: Einstellungsdialog zum Umbelegen (Phase 3), Kürzel für die Tabs anderer Fenster, Zwischenablage für Bilder oder Dateien, Kopieren beim Markieren, Menüeinträge für alle Befehle.
- Security: Das Terminal-Eingabedaten-Format bleibt der Weg über `session.input`. Der Renderer liest die Zwischenablage nur auf Tastendruck oder Rechtsklick des Benutzers und nur für die schreibende View; eine lesende View sendet nichts. Keine neue Berechtigung (Electron erteilt `clipboard-read` und `clipboard-write` der eigenen Seite von sich aus; ein späterer Permission-Handler muss sie erlauben).
- Breaking Changes: keine. `Alt+Pfeiltasten` gehören der App und erreichen die Shell nicht mehr (bis zur Umbelegung in Phase 3).
