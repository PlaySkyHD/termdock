# Proposal

## Why

TermDock startet bisher nur aus dem Repo (`npm start -w apps/desktop`), also mit Node, `npm ci` und einem Checkout. Phase 4 des Konzepts (Kapitel 12, „Packaging und Stabilisierung“) verlangt eine installierbare App. Nutzerentscheidung vom 19.11.2026 (#131): NSIS-Installer pro Benutzer, ohne Adminrechte, unsigniert; Auto-Update folgt später (#136).

## What Changes

- `apps/desktop` bekommt `electron-builder` 26.18.0 als devDependency und das Skript `npm run dist -w apps/desktop`. Es baut `apps/desktop/release/TermDock-Setup-<version>.exe` (NSIS, x64) und die entpackte App `release/win-unpacked`.
- Installer: nur für den aktuellen Benutzer nach `%LOCALAPPDATA%\Programs\TermDock`, ohne Auswahl „für alle Benutzer“ und ohne Elevation, Startmenü- und Desktop-Verknüpfung, deutsche Oberfläche, Deinstallation über „Apps“. Willkommensseiten von Installer und Deinstaller sagen, dass `%APPDATA%\TermDock` (Sessions, Verlauf, Einstellungen) stehen bleibt.
- App-Identität: `appId` `io.github.playskyhd.termdock`, `productName` TermDock, `apps/desktop/resources/icon.ico` (16–256 px) aus `assets/icon.svg`, erzeugt mit `npm run icon -w apps/desktop` und eingecheckt.
- `coreEntryPath({ packaged, resourcesPath })`: im Paket zeigt der Core-Einstieg auf `resources/app.asar.unpacked/node_modules/@termdock/core/dist/bin/termdock-core.js`. `@termdock/core`, `@termdock/protocol` und `node-pty` liegen per `asarUnpack` außerhalb von `app.asar`.
- Prüfmodus `--smoke-test`: startet ohne Fenster einen eigenen Core auf eigener Pipe mit `TERMDOCK_DATA_DIR`, wartet auf `hello` und `core.status`, beendet ihn mit `core.shutdown` und endet mit Exit-Code 0 oder 1 (2 bei falschen Argumenten).
- CI: neuer Job `package` (windows-latest) baut den Installer, lädt die nativen Module der entpackten App, führt den Prüfmodus aus und lädt den Installer als Artefakt hoch (7 Tage).
- Neue ADR 0007 „Paketierung und Installer“.

## Capabilities

### New Capabilities

- `packaging`: Bau des Installers, Inhalt des Pakets, Core-Einstieg im Paket, Prüfmodus, CI-Job.

### Modified Capabilities

(keine)

## Impact

- Pakete: nur `apps/desktop` (`core-process.ts`, `main.ts`, neu `smoke-test.ts`, `electron-builder.json`, `resources/`, `scripts/make-icon.mjs`), dazu `.github/workflows/ci.yml` und `.gitignore`. Core und Protocol bleiben unverändert; keine neue IPC-Methode, kein neues Datenmodell.
- `npm start` und der Screenshot-Modus verhalten sich unverändert (außerhalb des Pakets gilt der bisherige Core-Einstieg).

## Non-Goals

- Code-Signing, Auto-Update (#136), Microsoft Store, MSI, portable Version, ARM64.
- Ein eigener Electron-Profilordner im Paket: Electron legt sein Profil wie jede App unter `%APPDATA%\TermDock` ab, neben `termdock.db`.

## Security

- Kein Zertifikat, kein Token, kein Publish-Ziel (`publish: null`, `--publish never`); die CI braucht nur `contents: read`.
- Der Installer ist unsigniert; SmartScreen kann nachfragen. Das sagt die Willkommensseite.
- Der Prüfmodus läuft nur mit gesetztem `TERMDOCK_DATA_DIR` und eigener Pipe, eigenem tmux-Socket und eigenem Electron-Profil; er berührt weder den produktiven Core noch dessen Daten.

## Breaking Changes

Keine. `coreEntryPath` hat eine neue Signatur, ist aber nur intern im Desktop-Main verwendet.
