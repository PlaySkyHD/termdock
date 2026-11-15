# Proposal

## Why

Der Core speichert seit #55/#58/#86 Einstellungen und Startprofile, aber die Oberfläche kann sie nicht zeigen oder ändern; nur der Schließen-Dialog (#60) liest und schreibt zwei Schlüssel. Konzept Kap. 3 und Phase 3 (Kap. 12) verlangen einen Einstellungsdialog mit WSL-Distribution, Standardshell, Standardverzeichnis, Verlauf, Kürzeln und Startprofilen (#64). Für die Auswahl der Distribution fehlt eine IPC-Methode, die die WSL-Distributionen auflistet. Außerdem nutzt der Core `defaultDistro` und `defaultShell` bisher nirgends: Eine im Dialog gewählte Distribution hätte keine Wirkung.

## What Changes

- **Protokoll 1.4:** neue Methode `wsl.distros {}` mit Ergebnis `{ distros, defaultDistro?, unavailable? }` (höchstens 64 Namen). Ist WSL nicht erreichbar, ist die Liste leer und `unavailable` nennt den Grund; die Methode scheitert dann nicht.
- **Core:** beantwortet `wsl.distros` über das WSL-Backend (`wsl.exe -l -v`, Argument-Array, `WSL_UTF8=1`, 5 s Timeout). Neue Sessions und Profil-Sessions ohne `distro` (WSL) bzw. ohne `shell` (Windows) bekommen `defaultDistro` bzw. `defaultShell` der Einstellungen; ohne Einstellung bleibt es wie bisher (Standard-Distro von WSL).
- **Brücke:** sieben neue Aufrufe (`getSettings`, `updateSettings`, `listProfiles`, `createProfile`, `updateProfile`, `deleteProfile`, `listDistros`) mit Prüfung im Main, drei neue Events an die Fenster (`settingsChanged`, `profilesChanged`, `openSettings` aus dem Menü).
- **Desktop:** Einstellungsdialog über `Ctrl+,` und „Datei → Einstellungen …“ mit den Abschnitten Allgemein (Distribution aus der WSL-Liste, Standardshell, Standardverzeichnis, „Beim Schließen fragen“), Verlauf (Limit in MiB, Standard an/aus, Hinweis auf die Platte), Kürzel (Übersicht, nur lesen) und Startprofile (Liste, anlegen, bearbeiten, löschen; Backend, Distribution oder Shell, Verzeichnis, Befehl als Argumentliste, Umgebung, Autostart, Verlauf; Hinweis, dass Secrets nicht in die Umgebung gehören). Fokusfalle, Escape, Fehler des Core im Dialog. Formularprüfung als reine Funktionen.
- **Screenshot-Szenen** aller Abschnitte, des Editors und einer Fehleranzeige.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `ipc-protocol`: neue Methode `wsl.distros`, Version 1.4.
- `wsl-backend`: Distributionen für Clients auflisten.
- `settings`: Vorgaben für Distribution und Shell neuer Sessions.
- `desktop-shell`: Brücke um Einstellungen und Profile erweitert (MODIFIED); Einstellungsdialog, Abschnitte, Profil-Editor, Formularprüfung, Screenshot-Szenen (ADDED).

## Impact

- Pakete: `packages/protocol` (`messages.ts`, `guards.ts`, `model.ts`: `PROTOCOL_VERSION`, `MAX_WSL_DISTROS`), `packages/core` (`ipc/server.ts`, `bin/run-core.ts`, `backend/wsl/backend.ts`, `workspace/profile-service.ts`, neue reine Funktion für Startvorgaben), `apps/desktop` (Brücke, Preload, Menü in `main.ts`, Renderer: Dialog, Formularlogik, Keymap, Befehle, Fokusfalle, Stil, Screenshot-Szene).
- IPC: neue Methode `wsl.distros`; bestehende Methoden und Events bleiben unverändert. Ein Core 1.3 beantwortet `wsl.distros` mit `bad_request`; der Dialog zeigt dann ein freies Feld für die Distribution.
- Datenmodell: keine Migration; `Settings` und `LaunchProfile` bleiben gleich.
- Sicherheit: `wsl.exe` nur mit festem Argument-Array, keine Nutzereingabe im Aufruf. Der Dialog speichert keine Secrets; der Core lehnt Secret-artige Schlüssel in `env` weiter ab, der Dialog zeigt den Fehler. Der Main nimmt nur die festen Aufrufe an.
- Non-Goals: Kürzel umbelegen (die Übersicht bleibt lesend), Bindung von Profilen an Workspace und Projekt im Dialog, Starten einer Session aus einem Profil über die Oberfläche, Windows-Backend (#65).
- Breaking Changes: keine. Sessions ohne `distro` landen nach dem Setzen von `defaultDistro` in dieser Distribution statt in der WSL-Standard-Distribution; das ist die gewünschte Wirkung der Einstellung.
- Phase: 3 (Kap. 12, „Einstellungen und Startprofile“).
