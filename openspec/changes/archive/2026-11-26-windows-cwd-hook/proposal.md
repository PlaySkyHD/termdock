# Proposal

## Why

Der Datei-Explorer (#198) soll dem aktuellen Verzeichnis einer Session folgen. Bei WSL liefert tmux den Pfad (#199), eine Windows-Shell (`pwsh`, `powershell`, `cmd`) meldet ihn von sich aus nicht. Der Nutzer hat am 26.11.2026 zugestimmt, dass TermDock dafür beim Start einen Prompt-Hook setzt (#200).

## What Changes

- Core (`packages/core/src/backend/windows/`): Eine Windows-Shell ohne eigenen `launch.command` sendet bei jedem Prompt `ESC ] 9 ; 9 ; "<pfad>" ESC \` (OSC 9;9, ConEmu und Windows Terminal). PowerShell bekommt `-NoExit -Command <festes Skript>`, das nach dem Profil die `prompt`-Funktion umhüllt; `cmd` bekommt `PROMPT` mit der Sequenz vor dem bisherigen Wert. Alles als Argument-Array und Umgebung, ohne Nutzereingaben im Skript.
- Renderer (`apps/desktop/src/renderer/`): `terminal-controller.ts` registriert über xterm.js einen OSC-9-Handler; die reine Funktion `parseCwdOsc` (`osc-cwd.ts`) prüft den Pfad. Der Controller bietet `currentCwd()` und `onCwd(listener)`. Andere OSC-9-Sequenzen (Benachrichtigungen) bleiben unberührt.
- Keine neue Abhängigkeit, kein neues Protokollfeld, keine sichtbare UI-Änderung (das Panel kommt mit #202).

## Capabilities

### Modified Capabilities

- `windows-backend`: Start der Windows-Shell (MODIFIED, PowerShell-Argumente), Prompt-Hook (ADDED).
- `desktop-shell`: Aktuelles Verzeichnis aus OSC 9;9 (ADDED).
