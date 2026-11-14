# Proposal: Terminal-Modi im Attach-Snapshot

## Why

Der Snapshot bei `session.attach` enthält Bildschirm und Cursor, aber keine Terminal-Modi (#42). tmux setzt die Modi seines Clients (Application Cursor Keys, Keypad, Bracketed Paste) einmal beim Start des Clients und Mausberichte bei `set -g mouse on`; diese Sequenzen gehen an die PTY des Core, lange bevor eine View anhängt. Jede View, die später anhängt (nach dem Start, einem Split, einem Neuladen, der Layout-Wiederherstellung), kennt sie nicht: Rechtsklick fügt ein statt an tmux zu gehen, Pfeiltasten senden `ESC [ A` statt `ESC O A`, und der Terminal-Controller muss Bracketed Paste für WSL hart einschalten (Umgehung aus #28).

## What Changes

- Der Core verfolgt in der Ausgabe jeder Session die Modus-Sequenzen, die ein Terminal-Emulator als Zustand behält: Application Cursor Keys (DECCKM), Application Keypad, Mausberichte (Protokoll und Kodierung), Fokusberichte und Bracketed Paste.
- Beim Anhängen stellt der Core dem Snapshot die Sequenzen voran, die diese Modi aus dem Grundzustand herstellen. Das gilt für den Snapshot des Backends (tmux) und für den Rohdaten-Puffer. Die Modi entsprechen genau der Ausgabe bis zur Marke `outputSeq`.
- Ein Neustart setzt die verfolgten Modi zusammen mit dem Rohdaten-Puffer zurück (das Archivieren ebenso; eine archivierte Session nimmt keine View mehr an).
- Desktop: Die Umgehung `bracketedPaste` (Option des `TerminalController`, `BRACKETED_PASTE_ON`, Property in `TerminalView`/`PaneTree`) entfällt samt Tests; alle Views sind gleichwertig.
- ADR 0003 beschreibt den Snapshot-Inhalt mit Modi.

Keine Breaking Changes: Der Snapshot bleibt Bytes in den Nutzdaten der Attach-Antwort; ein älterer Desktop schreibt die zusätzlichen Sequenzen einfach mit.

## Non-Goals

- Kein neues Protokollfeld und keine neue `PROTOCOL_VERSION` (`packages/protocol` bleibt unverändert).
- Kein Alternate Screen, keine Cursorform und kein `win32-input-mode` (`ESC [ ? 9001 h` der ConPTY, von xterm.js nicht unterstützt) im Snapshot.
- Keine Änderung an Session-Events, `session-sync.ts` oder Brücken-Events (parallel #46).

## Capabilities

### New Capabilities

Keine.

### Modified Capabilities

- `session-lifecycle`: Der Snapshot für neue Views enthält vor dem Bildschirm die aktuellen Terminal-Modi der Session.

## Impact

- `packages/core`: neues reines Modul zum Verfolgen der Modi, `SessionRegistry.attachView` und die Ausgabe-Verarbeitung der Registry. Backend-Schnittstelle (`backend/types.ts`) und WSL-Backend bleiben unverändert.
- IPC: `session.attach` liefert dieselben Felder; nur die Snapshot-Bytes beginnen mit Modus-Sequenzen.
- `apps/desktop`: `terminal-controller.ts`, `TerminalView.tsx`, `PaneTree.tsx`, Tests, Kommentar in `screenshot-scenario.ts`.
- Datenmodell: unverändert, Modi werden nicht gespeichert (nach einem Core-Neustart setzt der neue tmux-Client sie erneut).
- Sicherheit: Der Core erzeugt nur Sequenzen aus einer festen Liste; Bytes aus der Ausgabe werden nicht in den Präfix kopiert. Terminal-Ausgabe bleibt Daten.
- Phase: Nacharbeit zu Phase 2 (Kapitel 12, mehrere Views je Session).
