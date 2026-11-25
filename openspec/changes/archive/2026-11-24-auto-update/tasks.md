# Tasks

## 1. Einstellung `checkForUpdates`

- [x] 1.1 Test und Umsetzung: `Settings.checkForUpdates?`, `SettingsPatch.checkForUpdates?: boolean | null`, Guards, `PROTOCOL_VERSION` 1.7 (`packages/protocol/src/guards-phase3.test.ts`, `guards.test.ts`, Handshake in `packages/core/src/ipc/ipc.test.ts`)
- [x] 1.2 Test und Umsetzung: Schlüssel im `SettingsRepository` (`packages/core/src/storage/settings-repository.test.ts`)
- [x] 1.3 Test und Umsetzung: Schalter „Nach Updates suchen“ in `settings-form.ts` (`renderer/settings-form.test.ts`), Checkbox in `SettingsDialog.tsx`, Schlüssel in der Prüfung der Brücke (`main/bridge.test.ts`)

## 2. Update-Logik

- [x] 2.1 Test und Umsetzung: `updateChecksAllowed`, `checksEnabled`, `nextUpdateOffer`, `updateMessage`, `updateSessionsNote` (`shared/update-decision.test.ts`)
- [x] 2.2 Test und Umsetzung: `UpdateService` mit `FakeUpdater` und falscher Uhr: Zeitplan, ausgeschaltete Suche, Fehler nur im Log, Angebot an alle Fenster, „Später“ je Version, einmaliges Installieren, `dispose` (`main/update-service.test.ts`)
- [x] 2.3 Test und Umsetzung: `QuitFlow.installUpdate`: Reihenfolge Speichern → `core.shutdown { stopSessions: false }` → Verbindung schließen → Installer; nichts bei laufendem Beenden; `before-quit` geht danach durch (`main/quit-flow.test.ts`)
- [x] 2.4 `main/electron-updater-port.ts` und Verdrahtung in `main.ts` (nur gepackt im normalen Start, `ManualUpdater` im Screenshot-Modus); Laden von electron-updater aus `app.asar` der entpackten App geprüft

## 3. Brücke und Renderer

- [x] 3.1 Test und Umsetzung: Aufrufe `updateState`, `answerUpdate` und Event `updateChanged` (`main/bridge.test.ts`), Preload
- [x] 3.2 `renderer/UpdateDialog.tsx` und Einbindung in `App.tsx` (Texte und Angebot aus `update-decision.ts`, Windows-Shells aus dem Store)
- [x] 3.3 Screenshot-Gruppe `update` (`main/screenshot-update.ts`, Präfix `96`) mit Sichtbarkeitsselektor; Reihenfolge der Gruppen in `main/screenshot.test.ts`

## 4. Paketierung und Release

- [x] 4.1 Test und Umsetzung: Publish-Ziel GitHub Draft in `electron-builder.json`, `dist` mit `--publish never`, `electron-updater` 6.8.11 (`main/packaging.test.ts`)
- [x] 4.2 `.github/workflows/release.yml` (Tag gegen Version, Bau, Prüfmodus, Draft-Release mit drei Dateien); Prüfung der Update-Dateien im Job `package` von `ci.yml`; Test der Workflow-Dateien (`main/packaging.test.ts`)
- [x] 4.3 Lokaler Bau `npm run dist -w apps/desktop`: `latest.yml`, `.blockmap`, `app-update.yml`; Prüfmodus der entpackten App mit `TERMDOCK_DATA_DIR` (Exit-Code 0)

## 5. Dokumentation

- [x] 5.1 ADR 0007 (Auto-Update, Release-Ablauf, Risiko ohne Signatur, manueller Abnahmeschritt Update A → B mit laufender tmux-Session), ADR 0002 (1.7), ADR 0006 (Update-Dialog), AGENTS.md und Lessons (Gruppe `update`, Präfix `96`)
