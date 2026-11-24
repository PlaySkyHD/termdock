# Proposal

## Why

Das installierte TermDock (#131, ADR 0007) bleibt bisher auf seiner Version stehen; jedes Update heißt: neuen Installer suchen, herunterladen, ausführen. Issue #136 verlangt, dass sich die installierte App über die GitHub Releases von `PlaySkyHD/termdock` selbst aktualisiert, vor dem Neustart fragt und laufende tmux-Sessions dabei behält, wie bei einem Core-Neustart (#130, #140). Phase 4 des Konzepts (Kapitel 12, „Packaging und Stabilisierung“).

Nutzerentscheidungen vom 24.11.2026: unsigniert (SmartScreen beim Erstinstallieren wird akzeptiert, Integrität über die SHA-512 in `latest.yml`), ein Release-Workflow legt bei einem Tag `v*` nur ein Draft-Release an, das der Nutzer per Klick veröffentlicht, das Update fragt mit „Jetzt neu starten / Später“, Download im Hintergrund, kein Zwangsneustart.

## What Changes

- `apps/desktop` bekommt `electron-updater` 6.8.11 als Dependency. `electron-builder.json` erhält das Publish-Ziel GitHub `PlaySkyHD/termdock` (Draft), damit der Bau `latest.yml`, die `.blockmap` und im Paket `app-update.yml` erzeugt. `npm run dist` bleibt `--publish never`, lokal ohne Token nutzbar.
- Neuer Workflow `.github/workflows/release.yml`: bei Push eines Tags `v*` prüft er, dass der Tag der Version in `apps/desktop/package.json` entspricht, baut den Installer, führt den Prüfmodus aus und legt mit `gh release create --draft` ein Draft-Release mit Installer, `.blockmap` und `latest.yml` an. Nur `GITHUB_TOKEN` mit `contents: write` im Job, Actions mit fester Version.
- Der CI-Job `package` prüft zusätzlich, dass `latest.yml` und `.blockmap` entstehen.
- Desktop-Main: ein Update-Dienst prüft nur in der gepackten App im normalen Start (nicht im Screenshot- oder Prüfmodus, nicht aus dem Repo), 30 s nach dem Start und danach alle 4 Stunden, lädt im Hintergrund und meldet ein heruntergeladenes Update allen Fenstern. Fehler gehen nur ins Log (`desktop.log`, #129).
- Renderer: ein nicht-modaler Update-Dialog unten rechts im Fenster („Update auf Version X ist bereit“, „Jetzt neu starten“, „Später“), der den Fokus nicht aus dem Terminal nimmt. Laufen Windows-Shells, sagt er, dass sie mit dem Update enden; WSL-Sessions laufen weiter.
- „Jetzt neu starten“: Layout speichern, Core mit `core.shutdown { stopSessions: false }` beenden (tmux-Sessions und WSL-Keepalive bleiben), Verbindung schließen, Installer still mit Neustart der App ausführen. Der neue Core gleicht beim Start ab und bindet die tmux-Sessions wieder an. „Später“ blendet den Dialog bis zum nächsten Start der App aus; ein Beenden installiert nichts.
- Einstellung `checkForUpdates` (Protokoll 1.7, optional, fehlend heißt an) mit Checkbox „Nach Updates suchen“ im Abschnitt „Allgemein“ des Einstellungsdialogs.
- Neue Bridge-Aufrufe `updateState` und `answerUpdate`, neues Event `updateChanged`.
- Screenshot-Gruppe `update` (Präfix `96`) mit einem eingespeisten Update.
- ADR 0007 hält Release-Ablauf, Auto-Update und das Risiko ohne Signatur fest und bekommt in seiner manuellen Abnahme den Schritt „Update von Version A auf B mit laufender tmux-Session“; ADR 0002 die Version 1.7, ADR 0006 den Dialog. `docs/acceptance.md` belegt nur die 15 V1-Kriterien, zu denen das Update nicht gehört; es bleibt unverändert.

## Capabilities

### New Capabilities

- `auto-update`: wann die App nach Updates sucht, der Update-Dialog, das Beenden des Core vor der Installation und der Release-Workflow.

### Modified Capabilities

- `packaging`: Der Installer hat jetzt ein Publish-Ziel (GitHub, Draft) für die Update-Dateien; der CI-Job prüft sie.
- `ipc-protocol`: `Settings` hat den optionalen Schlüssel `checkForUpdates`, Protokollversion 1.7.
- `desktop-shell`: Der Abschnitt „Allgemein“ des Einstellungsdialogs zeigt „Nach Updates suchen“.

## Impact

- Pakete: `apps/desktop` (neu `main/update-service.ts`, `main/electron-updater-port.ts`, `shared/update-decision.ts`, `renderer/UpdateDialog.tsx`, `main/screenshot-update.ts`; geändert `main.ts`, `bridge.ts`, `quit-flow.ts`, `preload.cts`, `shared/bridge.ts`, `App.tsx`, `SettingsDialog.tsx`, `settings-form.ts`, `screenshot.ts`, `screenshot-scenario.ts`, `electron-builder.json`, `package.json`), `packages/protocol` (`Settings`, `SettingsPatch`, Guards, `PROTOCOL_VERSION`), `packages/core` (Schlüssel im `SettingsRepository`).
- IPC: `settings.get`/`settings.set`/`settings.changed` tragen `checkForUpdates`; keine neue Core-Methode.
- Datenmodell: eine Zeile `checkForUpdates` in der Tabelle `settings`, nur wenn der Nutzer sie setzt.

## Non-Goals

- Code-Signing, `publisherName`-Prüfung, automatisches Veröffentlichen eines Releases, Vorabversionen (Prerelease), Delta-Updates außerhalb dessen, was electron-updater mit der `.blockmap` ohnehin tut, Rückkehr zu einer älteren Version.
- Windows-Shells über ein Update retten: Sie leben im Core (ADR 0001) und enden mit ihm.
- Ein Update aus der Repo-App (`npm start`).

## Security

- Ohne Signatur prüft electron-updater nur die SHA-512 aus `latest.yml`; wer das Release oder das Konto `PlaySkyHD` übernimmt, kann ein beliebiges Programm verteilen. Gegenmaßnahme: Releases entstehen nur als Draft, der Nutzer veröffentlicht von Hand; HTTPS zu GitHub. Das Risiko steht in ADR 0007.
- Der Workflow nutzt nur `GITHUB_TOKEN` mit `contents: write` im Release-Job (Rest `contents: read`), keine weiteren Secrets; den Token sieht nur der Schritt `gh release create`. Tag und Version gehen als Umgebungsvariablen in die Skripte, nicht als Ausdruck im Shell-Text.
- Der Update-Dienst spricht nur mit GitHub (HTTPS); die Core-IPC bleibt lokal. Logs nennen Versionen und Fehlermeldungen, keine Tokens.

## Breaking Changes

Keine. Ein Core 1.6 lehnt `settings.set { checkForUpdates }` mit `bad_request` ab; `settings.get` eines Core 1.6 bleibt für einen Client 1.7 gültig (der Schlüssel ist optional).
