# Tasks

## 1. Protokoll

- [x] 1.1 Test und Umsetzung: `wsl.distros` (Parameter ohne Felder, Ergebnis mit Grenzen, `defaultDistro` in der Liste, `unavailable`), Version 1.4 (`packages/protocol/src/guards-phase3.test.ts`, `guards.test.ts`, `messages.ts`, `guards.ts`, `model.ts`)

## 2. Core

- [x] 2.1 Test und Umsetzung: `launchDefaults` (Distribution, Shell, nichts überschreiben) (`workspace/launch-defaults.test.ts`)
- [x] 2.2 Test und Umsetzung: `session.create` und Profil-Sessions mit Vorgaben aus den Einstellungen (`ipc/ipc.test.ts`, „settings dialog (issue #64)“)
- [x] 2.3 Test und Umsetzung: `wsl.distros` im Server (Liste, Filter, Fehler als `unavailable`, ohne Backend) (`ipc/ipc.test.ts`), eigener Timeout von `WslBackend.distros` (`backend/wsl/backend.test.ts`)
- [x] 2.4 Verdrahtung in `runCore` und WSL-Integrationstest mit `TERMDOCK_WSL_TESTS=1` (`backend/wsl/backend.wsl.test.ts`)

## 3. Brücke

- [x] 3.1 Test und Umsetzung: neue Aufrufe mit Prüfung, Weitergabe an den Core, Events `settingsChanged`/`profilesChanged` (`main/bridge.test.ts`, `main/bridge.ts`, `shared/bridge.ts`, `preload.cts`)
- [x] 3.2 Menüeintrag „Einstellungen …“ mit Event `openSettings` an das fokussierte Fenster (`main/main.ts`, geprüft durch die Szene in 5.1 über dasselbe Event)

## 4. Renderer

- [x] 4.1 Test und Umsetzung: Formularprüfung (`renderer/settings-form.test.ts`: Befehl als Array, leerer Name, ungültiger Pfad, Umgebung, Limit, Patches)
- [x] 4.2 Test und Umsetzung: Befehl `openSettings` mit `Ctrl+,` (`renderer/keymap.test.ts`, `commands.test.ts`)
- [x] 4.3 Test und Umsetzung: Fokusfalle mit `select` und `textarea` (`renderer/focus-trap.test.ts`)
- [x] 4.4 `SettingsDialog.tsx` mit vier Abschnitten, Profil-Editor, Fehleranzeige, Events; Stil in `styles.css` (geprüft durch die Szene in 5.1)

## 5. Screenshot-Szene und Doku

- [ ] 5.1 `screenshot-settings.ts`: Abschnitte, Liste, Editor, Fehleranzeige, Prüfung im Core (Lauf `npm run screenshot -w apps/desktop`, Exit-Code 0)
- [x] 5.2 ADR 0002 (Version 1.4, `wsl.distros`) und ADR 0006 (Brücke, Dialog) anpassen
