## REMOVED Requirements

### Requirement: Installer pro Benutzer

**Reason**: Der Installer hat seit #136 ein Publish-Ziel (GitHub, Draft) für die Update-Dateien; „ohne Publish-Ziel“ gilt nicht mehr. Die Anforderung steht neu als „Installer pro Benutzer mit Update-Dateien“.
**Migration**: Keine für Nutzer. `npm run dist -w apps/desktop` baut wie bisher ohne Upload und legt zusätzlich `latest.yml` und `.blockmap` ab.

## ADDED Requirements

### Requirement: Installer pro Benutzer mit Update-Dateien

`npm run dist -w apps/desktop` SHALL `apps/desktop/release/TermDock-Setup-<version>.exe` bauen: NSIS, x64, unsigniert, `appId` `io.github.playskyhd.termdock`, `productName` TermDock, Publish-Ziel GitHub `PlaySkyHD/termdock` (Draft) ohne Upload (`--publish never`). Der Installer MUST nur für den aktuellen Benutzer nach `%LOCALAPPDATA%\Programs\TermDock` installieren, ohne Adminrechte und ohne Auswahl „für alle Benutzer“, mit Startmenü- und Desktop-Verknüpfung.

#### Scenario: Installation ohne Adminrechte

- **GIVEN** ein Windows-Benutzer ohne Adminrechte
- **WHEN** er `TermDock-Setup-<version>.exe` ausführt
- **THEN** fragt der Installer weder nach Elevation noch nach „für alle Benutzer“
- **AND** TermDock liegt danach in `%LOCALAPPDATA%\Programs\TermDock` und startet über den Startmenü-Eintrag

#### Scenario: Konfiguration mit Publish-Ziel ohne Upload

- **GIVEN** `apps/desktop/electron-builder.json` und das Skript `dist` aus `apps/desktop/package.json`
- **WHEN** der Test beide liest
- **THEN** sind `oneClick`, `perMachine` und `allowElevation` falsch, das Ziel ist `nsis`, `publish` ist GitHub `PlaySkyHD/termdock` mit `releaseType` `draft` ohne `publisherName`, und `dist` baut mit `--publish never`

#### Scenario: Update-Dateien

- **WHEN** `npm run dist -w apps/desktop` fertig ist
- **THEN** liegen in `apps/desktop/release/` `TermDock-Setup-<version>.exe`, `TermDock-Setup-<version>.exe.blockmap` und `latest.yml`, und `win-unpacked/resources/app-update.yml` nennt `PlaySkyHD/termdock`

## MODIFIED Requirements

### Requirement: CI-Paketierung

Die CI SHALL in einem Job `package` auf `windows-latest` den Installer mit `npm run dist -w apps/desktop` bauen, prüfen, dass `latest.yml` und die `.blockmap` entstanden sind, die nativen Module von node-pty in der entpackten App laden, den Prüfmodus mit `TERMDOCK_DATA_DIR` im Temp-Ordner des Runners ausführen und den Installer als Artefakt mit 7 Tagen Aufbewahrung hochladen. Ein Fehlschlag eines Schritts MUST den Job rot machen.

#### Scenario: Pull Request

- **GIVEN** ein Pull Request gegen `main`
- **WHEN** die CI läuft
- **THEN** ist der Job `package` grün und das Artefakt `TermDock-Setup` enthält `TermDock-Setup-<version>.exe`
