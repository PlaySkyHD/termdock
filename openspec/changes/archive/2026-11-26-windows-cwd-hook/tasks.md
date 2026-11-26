# Tasks

## 1. Core: Prompt-Hook

- [x] 1.1 Argumente und Umgebung des Hooks als reine Funktionen (`backend/windows/shells.test.ts`, „runs the shell with its own arguments and the prompt hook of PowerShell“, „is a constant PowerShell script …“, „puts the hook in front of PROMPT of cmd …“, „leaves PowerShell and every session with its own command alone …“, „sets no hook arguments when the spec has its own command“)
- [x] 1.2 Das Backend übergibt Hook-Argumente und `PROMPT` nur ohne `launch.command` (`backend/windows/backend.test.ts`, „pins pwsh when installed …“, „sets the prompt hook of cmd only without launch.command“, „starts the shell without the TERMDOCK_* variables of the core“)
- [x] 1.3 Echtes `cmd.exe` sendet OSC 9;9 bei jedem Prompt (`backend.test.ts`, „makes the real cmd report its directory with OSC 9;9 at each prompt“)

- [x] 1.4 PowerShell: Profil mit eigener `prompt`-Funktion bleibt erhalten, ein Fehler in ihr macht die Shell nicht unbenutzbar, `HKLM:` meldet nichts; geprüft von Hand mit einem Node-Skript außerhalb des Repos über `spawnConpty` und `launchProgram` (Ergebnis im PR/Bericht)

## 2. Renderer: OSC 9;9

- [x] 2.1 `parseCwdOsc` und `validCwd`: Formen, Steuerzeichen, Länge, absolut, andere OSC 9 (`renderer/osc-cwd.test.ts`)
- [x] 2.2 Controller: `currentCwd`, `onCwd`, Snapshot, ungültige Pfade, Weitergabe anderer OSC 9, Abbau (`renderer/terminal-controller.test.ts`, „current directory of a Windows shell (OSC 9;9, #200)“)
- [x] 2.3 `TerminalView.tsx` verbindet `onOsc9` mit `parser.registerOscHandler(9, …)`; geprüft durch `npm run typecheck` und den manuellen Nachweis (pwsh/cmd über die Core-Startfunktion, OSC 9;9 mit Pfad in der Ausgabe)
