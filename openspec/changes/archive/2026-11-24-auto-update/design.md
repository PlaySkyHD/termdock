# Design

## Kontext

Die installierte App (ADR 0007) ist ein NSIS-Installer pro Benutzer, unsigniert. Der Core läuft losgelöst als `TermDock.exe` mit `ELECTRON_RUN_AS_NODE=1` (ADR 0001); sein WSL-Keepalive läuft losgelöst davon und hält die Distro samt tmux-Sessions über ein Ende des Core wach (#140). Ein Core-Neustart gleicht ab und bindet die tmux-Sessions wieder an (#130, ADR 0005). Windows-Shells leben als PTY im Core und enden mit ihm (#65).

## Entscheidungen

### electron-updater als neue Dependency

`electron-updater` 6.8.11 (gepinnt, `dependencies` von `apps/desktop`, landet in `app.asar`). Begründung: Er gehört zu electron-builder (gleiche `builder-util-runtime` 9.7.0 wie electron-builder 26.18.0), liest `app-update.yml`, die electron-builder ins Paket legt, findet über den GitHub-Provider das neueste veröffentlichte Release (Drafts sieht er nicht), lädt im Hintergrund mit Prüfung gegen die SHA-512 aus `latest.yml`, nutzt die `.blockmap` für Teil-Downloads und startet den NSIS-Installer still mit Neustart der App. Eigenbau hieße: Release-Abfrage, Download mit Prüfsumme, Cache und Installer-Aufruf selbst schreiben und pflegen. Electrons eingebauter `autoUpdater` kann unter Windows nur Squirrel, nicht NSIS.

Einstellungen: `autoDownload: true`, `autoInstallOnAppQuit: false` (ein normales Beenden behält nach Wahl des Nutzers den Core samt Windows-Shells; ein stilles Update beim Beenden würde sie beenden), `allowPrerelease: false`, `logger` ist `logger.withSource("updater")` (`desktop.log`). Ohne `publisherName` in `app-update.yml` überspringt der NSIS-Updater die Signaturprüfung; mehr als die SHA-512 gibt es ohne Zertifikat nicht (Risiko siehe ADR 0007).

### Schmale Schnittstelle, reine Logik

- `shared/update-decision.ts` (rein): `updateChecksAllowed({ packaged, mode })` (nur `packaged` und Modus `app`), `checksEnabled(settings)` (`checkForUpdates !== false`, ein Core ohne Antwort gilt als an), `updateMessage(version)`, `updateSessionsNote(windowsSessions)` (WSL läuft weiter, Windows-Shells enden) und `UPDATE_FIRST_CHECK_MS`/`UPDATE_CHECK_INTERVAL_MS`. Welche Sessions überleben, zählt `countActiveWindows` aus `quit-decision.ts` (dieselbe Regel wie im Schließen-Dialog).
- `main/update-service.ts` (ohne Electron): `UpdateService` mit eingespeistem `UpdaterPort` (`check()`, `onDownloaded(version)`, `onError(error)`, `install()`), Uhr (`setTimeout`/`clearTimeout`), `readSettings`, `broadcast`, `releaseAndInstall`, `log`. Er plant die Suchen, merkt sich die geladene Version und „Später“ je Version für die Laufzeit des Main, sendet `updateChanged` an alle Fenster und lässt „Jetzt neu starten“ genau einmal durch. `FakeUpdater` im Test, `ManualUpdater` (gleiche Datei) im Screenshot-Modus.
- `main/electron-updater-port.ts`: einziger Import von `electron-updater`, übersetzt `autoUpdater` auf `UpdaterPort`.
- `QuitFlow.installUpdate(install)`: wie ein Beenden mit „Sessions behalten“, aber mit `core.shutdown { stopSessions: false }` statt ohne Shutdown, und am Ende `install()` (→ `quitAndInstall(true, true)`) statt `app.quit()`. Läuft schon ein Beenden, gibt sie `false` zurück und tut nichts. `retainAll` setzt den Supervisor auf `stopped`, also startet kein Neustart den Core während der Installation neu. `quitAndInstall` ruft selbst `app.quit()`; `before-quit` lässt es durch, weil der Ablauf dann als fertig gilt.

### Core vor der Installation beenden

`core.shutdown { stopSessions: false }` ist der Abbau aus ADR 0001: Pipe zu, PTYs lösen, Keepalive bleibt, Datenbank zu, Prozess endet. Das ist dasselbe wie das Ende des Core bei einem Absturz, nur geordnet; der nächste Core übernimmt den Keepalive und bindet die tmux-Sessions an. Ein Core, der nicht antwortet, hält die Installation nicht auf: Der Installer beendet jedes `TermDock.exe` ohnehin (ADR 0007, „Folgen“).

### Dialog nicht-modal

Der Nutzer entschied „Jetzt neu starten / Später“ als Dialog. Er erscheint, wenn der Download fertig ist, also zu einem beliebigen Zeitpunkt, oft mitten im Tippen. Ein modaler Dialog mit Fokusfalle wie beim Beenden (#60) würde die nächsten Tasten schlucken oder mit Enter ungewollt neu starten. Darum: ein Dialog (`role="dialog"`, `aria-modal="false"`) unten rechts, über den Panes, ohne Fokus beim Erscheinen; Escape im Dialog heißt „Später“. Er steht in jedem Fenster; eine Antwort gilt für alle.

### Bridge

- Aufruf `updateState` → `{ version?: string }`: das geladene, noch nicht abgelehnte Update; ein Fenster, das später lädt, fragt es einmal (wie `coreConnection`).
- Aufruf `answerUpdate { choice: "install" | "later" }`; der Main prüft die Form, eine Antwort ohne geladenes Update ergibt `not_found`.
- Event `updateChanged { version?: string }` an alle Fenster: mit Version zeigen, ohne ausblenden.

### Einstellung `checkForUpdates`

Es gibt einen Einstellungsweg (Core-Tabelle `settings`, Dialog #64), also kommt der Schalter dorthin und nicht in eine eigene Datei des Desktop. Optional (fehlend heißt an), damit ein Client 1.7 die Einstellungen eines Core 1.6 weiter liest; deshalb Protokoll 1.7 (ADR 0002: neue optionale Felder erhöhen die Nebenversion). Der Main liest sie vor jeder Suche; ausgeschaltet sucht er nicht, ein schon geladenes Update bleibt angeboten.

### Release-Workflow

`.github/workflows/release.yml`, Auslöser `push: tags: ["v*"]`, oberste `permissions: contents: read`, Job `release` mit `contents: write`. Schritte: Checkout, Node, `npm ci`, Electron-Binary, Vergleich `v<version>` aus `apps/desktop/package.json` mit `GITHUB_REF_NAME` (über `env`, nicht als `${{ }}` im Skript), `npm run dist -w apps/desktop` (weiter `--publish never`), Prüfmodus, Prüfung der drei Dateien, dann `gh release create "$TAG" --draft --verify-tag --generate-notes` mit `GH_TOKEN: ${{ github.token }}` nur in diesem Schritt. Kein Upload durch electron-builder: So sieht der Token weder electron-builder noch die NSIS-Downloads. Die Actions sind dieselben gepinnten SHAs wie in `ci.yml`. Eine Version veröffentlicht der Nutzer: Version in `apps/desktop/package.json` per PR erhöhen, Tag `v<version>` auf `main` pushen, Draft prüfen und veröffentlichen.

### Screenshot-Szene

Gruppe `update`, Präfix `96` (frei, über den Blöcken, die #68 wahrscheinlich nimmt). Im Screenshot-Modus nutzt der `UpdateService` den `ManualUpdater`; `ScenarioControl.offerUpdate(version)` meldet ein geladenes Update, `installRequests()` zählt „Jetzt neu starten“, ohne etwas zu beenden. Die Szene legt eine WSL-Session und eine Windows-Shell an, nimmt den Dialog mit Hinweis auf (`visible: '[data-dialog="update"] [data-update="sessions"]'`), prüft den Fokus im Terminal, „Später“ in einem zweiten Fenster, das erneute Anbieten nach einem neuen Angebot, und „Jetzt neu starten“ (genau ein Aufruf).

## Risiken

- Unsigniert: Integrität hängt an GitHub und dem Konto (ADR 0007). Drafts und manuelles Veröffentlichen begrenzen Fehler im Workflow, nicht ein übernommenes Konto.
- Ein Update ohne laufendes WSL: Der Keepalive fehlt, die Distro kann während der Installation enden (wie bei jedem Core-Ende); dann gibt es keine tmux-Sessions zu retten.
- Der Installer ersetzt `TermDock.exe`, während eine Repo-App läuft: nicht betroffen, sie liegt nicht unter `$INSTDIR`; aber sie teilt die Pipe (ADR 0007, Abnahme Schritt 1).
