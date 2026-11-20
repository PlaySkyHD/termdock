# ADR 0007: Paketierung und Installer

Status: angenommen (19.11.2026)

## Kontext

Phase 4 des Konzepts (Kapitel 12) verlangt eine App, die sich ohne Repo und ohne Node installieren lässt. Der Core ist ein eigener Prozess, den Electron als Node startet (ADR 0001); node-pty bringt N-API-Prebuilds mit, SQLite ist `node:sqlite`. Nutzerentscheidung vom 19.11.2026 (#131): NSIS-Installer pro Benutzer, ohne Adminrechte, unsigniert. Auto-Update ist #136.

## Entscheidung

- **Werkzeug:** `electron-builder` (devDependency von `apps/desktop`, gepinnt), Konfiguration in `apps/desktop/electron-builder.json`, Bau mit `npm run dist -w apps/desktop` nach `apps/desktop/release/` (`TermDock-Setup-<version>.exe`, entpackt `win-unpacked`). Electron kommt aus `node_modules/electron/dist`, also dieselbe Version wie bei `npm start`. Kein Publish-Ziel (`publish: null`, `--publish never`), kein Zertifikat.
- **Installer:** NSIS mit Assistent (`oneClick: false`), nur für den aktuellen Benutzer (`perMachine: false`, `allowElevation: false`, Makro `customInstallMode` in `resources/installer.nsh` überspringt die Auswahl „für alle Benutzer“), Ziel `%LOCALAPPDATA%\Programs\TermDock`, deutsche Oberfläche, Startmenü- und Desktop-Verknüpfung, Deinstallation über „Apps“. Die Willkommensseiten nennen Zielordner, Datenordner, dass ein laufendes TermDock samt Core beendet wird und dass laufende WSL-Sessions dabei weiterlaufen (#140).
- **Identität:** `appId` `io.github.playskyhd.termdock`, `productName` TermDock. Das Icon `resources/icon.ico` (16–256 px) erzeugt `npm run icon -w apps/desktop` (`scripts/make-icon.mjs`, Electron zeichnet `assets/icon.svg`); es ist eingecheckt, weil der Buchstabe die Systemschrift nutzt.
- **Daten:** Der Datenordner bleibt `%APPDATA%\TermDock`; die Deinstallation lässt ihn stehen (`deleteAppDataOnUninstall: false`). Das Electron-Profil (`userData`) setzt der Main ausdrücklich auf `%APPDATA%\@termdock\desktop` (`appUserDataDir`), im Repo und im Paket gleich, unabhängig vom npm-Namen. Damit teilen Repo-App und installierte App die Einzelinstanz-Sperre: Nie laufen zwei Mains auf einem Core. Im Paket setzt der Main die AppUserModelID `io.github.playskyhd.termdock` (= `appId`), sonst zeigt die Taskleiste zwei Symbole.
- **Paketinhalt:** `dist/main`, `dist/preload`, `dist/shared`, `dist/renderer` ohne Tests; React und xterm.js nur gebündelt im Renderer. `@termdock/core`, `@termdock/protocol` und `node-pty` liegen per `asarUnpack` in `resources/app.asar.unpacked`. Kein Rebuild nativer Module (`npmRebuild: false`): node-pty lädt seine N-API-Prebuilds unter der Electron-ABI.
- **Core im Paket:** `coreEntryPath({ packaged, resourcesPath })` liefert im Paket `resources/app.asar.unpacked/node_modules/@termdock/core/dist/bin/termdock-core.js`, sonst wie bisher `packages/core/dist/bin/termdock-core.js`. Der Core läuft weiter als `process.execPath` (`TermDock.exe`) mit `ELECTRON_RUN_AS_NODE=1` (ADR 0001), ganz außerhalb von `app.asar`.
- **Prüfmodus `--smoke-test`:** ohne Fenster, nach dem Vorbild des Screenshot-Modus (ADR 0006): eigene Pipe, eigener tmux-Socket, Electron-Profil unter `TERMDOCK_DATA_DIR`, keine Einzelinstanz-Sperre. Die App startet den Core, wartet auf `hello` und `core.status` (höchstens 90 s, ein danach noch startender Core wird bis zu 15 s abgewartet), beendet ihn mit `core.shutdown { stopSessions: true }` (sonst Kill) und endet mit 0; Fehler ergeben 1. Fehlendes `TERMDOCK_DATA_DIR`, `%APPDATA%\TermDock` oder ein Ordner darin (ein zweiter Core auf der produktiven Datenbank würde deren Sessions gegen den leeren tmux-Socket der Prüfung abgleichen) oder `--screenshot` daneben ergeben 2.
- **CI:** Job `package` auf `windows-latest`: `npm ci`, `npm run dist -w apps/desktop`, Laden von `conpty.node` und `pty.node` mit dem gepackten Electron, `TermDock.exe --smoke-test` mit `TERMDOCK_DATA_DIR` unter `runner.temp`, Upload des Installers als Artefakt `TermDock-Setup` (7 Tage). Ohne WSL meldet der Core `wsl` als nicht verfügbar; das ist erwartet.

## Abnahme (manuell, mit dem Nutzer)

1. Repo-App (alle Fenster) und Repo-Core beenden (`docs/agent-lessons-learned.md`, Abschnitt 1). Sonst übergibt die installierte App an den laufenden Repo-Main (gemeinsame Einzelinstanz-Sperre) oder verbindet sich mit dem Repo-Core (gleiche Pipe).
2. `TermDock-Setup-<version>.exe` aus dem CI-Artefakt oder `apps/desktop/release/` ausführen (SmartScreen: „Weitere Informationen“, „Trotzdem ausführen“). Es kommt keine UAC-Abfrage und keine Auswahl „für alle Benutzer“.
3. Startmenü-Eintrag „TermDock“ starten, eine WSL-Session anlegen und darin tippen. Die Taskleiste zeigt ein TermDock-Symbol.
4. TermDock beenden, über „Einstellungen → Apps“ deinstallieren. `%LOCALAPPDATA%\Programs\TermDock` ist weg, `%APPDATA%\TermDock\termdock.db` ist noch da.

## Folgen

- Ein Update oder eine Deinstallation beendet laufende `TermDock.exe`-Prozesse nach Rückfrage, auch den Core im Hintergrund, und zwar ohne `core.shutdown`. Der WSL-Keepalive läuft losgelöst vom Core und liegt nicht unter `$INSTDIR` (`wsl.exe` in `System32`); er überlebt das Update und hält die Distro samt tmux-Sessions wach (ADR 0003, #140). Der nächste Start gleicht ab (ADR 0005), bindet die Sessions wieder an und übernimmt den Keepalive.
- Ohne Signatur warnt SmartScreen. Signatur, Auto-Update (#136), Store, MSI und ARM64 sind nicht Teil dieser Entscheidung.
- Der Bau lädt NSIS und 7-Zip aus den GitHub-Releases von electron-builder.
