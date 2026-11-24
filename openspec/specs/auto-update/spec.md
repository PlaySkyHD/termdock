# auto-update Specification

## Purpose
Legt fest, wie sich das installierte TermDock über die GitHub Releases von `PlaySkyHD/termdock` selbst aktualisiert: wann es sucht, wie es fragt, wie laufende tmux-Sessions das Update überleben, und wie der Release-Workflow ein Draft-Release baut (ADR 0007).

## Requirements

### Requirement: Wann die App nach Updates sucht

Der Desktop-Main SHALL nur in der gepackten App im normalen Start nach Updates suchen: nicht aus dem Repo, nicht im Screenshot- und nicht im Prüfmodus. Die erste Suche SHALL 30 s nach dem Start laufen, danach alle 4 Stunden, jeweils nur wenn `checkForUpdates` nicht `false` ist (gelesen vor jeder Suche; ohne Antwort des Core fällt sie aus). Ein gefundenes Update SHALL im Hintergrund laden; ein Beenden der App MUST es nicht installieren.

#### Scenario: App aus dem Repo

- **GIVEN** die App läuft mit `npm start` (nicht gepackt) oder mit `--screenshot` oder `--smoke-test`
- **WHEN** der Main startet
- **THEN** sucht er nie nach Updates

#### Scenario: Gepackte App mit Standardeinstellungen

- **GIVEN** die installierte App, `checkForUpdates` ist nicht gesetzt
- **WHEN** 30 s nach dem Start vergehen und danach 4 Stunden
- **THEN** sucht der Main je einmal nach Updates

#### Scenario: Suche ausgeschaltet

- **GIVEN** die installierte App und `checkForUpdates: false`
- **WHEN** die Zeit der nächsten Suche kommt
- **THEN** sucht der Main nicht; nach `checkForUpdates: true` sucht er bei der folgenden Zeit wieder

#### Scenario: Core antwortet nicht

- **GIVEN** die installierte App, der Core beantwortet `settings.get` zur Zeit der Suche nicht (Neustart, Timeout)
- **WHEN** die Zeit der Suche kommt
- **THEN** sucht der Main nicht, schreibt den Grund nach `desktop.log` und versucht es zur nächsten Zeit wieder

### Requirement: Fehler blockieren nie

Scheitert eine Suche oder ein Download (kein Netz, GitHub nicht erreichbar, falsche Prüfsumme, keine Einstellungen vom Core), SHALL der Main den Grund nach `desktop.log` schreiben und weiterlaufen. Er MUST dabei weder einen Dialog zeigen noch ein Fenster, den Core oder das Beenden aufhalten; die nächste Suche läuft zur nächsten Zeit.

#### Scenario: Kein Netz

- **GIVEN** die installierte App ohne Netz
- **WHEN** die Suche scheitert
- **THEN** steht der Fehler in `desktop.log`, kein Fenster zeigt etwas, und die App läuft normal weiter

### Requirement: Update-Dialog

Ist ein Update geladen, SHALL jedes Fenster unten rechts einen nicht-modalen Dialog zeigen: „Update auf Version <v> ist bereit.“, „Jetzt neu starten“ und „Später“. Er MUST den Fokus nicht aus dem Terminal nehmen. Laufen Windows-Shells (`Running` oder `Detached`), MUST er sagen, dass sie mit dem Neustart enden; WSL-Sessions SHALL er als weiterlaufend nennen. „Später“ SHALL den Dialog in allen Fenstern bis zum nächsten Start der App ausblenden.

#### Scenario: Update mit laufender Windows-Shell

- **GIVEN** ein geladenes Update 0.2.0, eine WSL-Session und eine Windows-Shell laufen
- **WHEN** das Fenster den Dialog zeigt
- **THEN** nennt er Version 0.2.0, dass WSL-Sessions weiterlaufen und dass die Windows-Shell beim Neustart endet
- **AND** das Terminal behält den Fokus

#### Scenario: Später

- **GIVEN** zwei Fenster zeigen den Dialog
- **WHEN** der Nutzer in einem „Später“ klickt
- **THEN** verschwindet er in beiden, und bis zum nächsten Start der App erscheint er für diese Version nicht wieder

#### Scenario: Später geöffnetes Fenster

- **GIVEN** ein geladenes Update, das noch nicht abgelehnt ist
- **WHEN** ein neues Fenster lädt
- **THEN** zeigt es den Dialog ebenfalls

### Requirement: Installation mit überlebenden tmux-Sessions

„Jetzt neu starten“ SHALL das Layout speichern, den Core ohne Neustart mit `core.shutdown { stopSessions: false }` beenden (tmux-Sessions und WSL-Keepalive bleiben, Windows-Shells enden), die Verbindung schließen und dann den Installer still mit Neustart der App starten. Läuft schon ein Beenden der App, MUST der Klick nichts tun. Nach dem Neustart SHALL der neue Core wie bei einem Core-Neustart abgleichen und die WSL-Sessions wieder anbinden.

#### Scenario: Update mit laufender tmux-Session

- **GIVEN** die installierte Version A mit einer WSL-Session in `Running`, ein geladenes Update B
- **WHEN** der Nutzer „Jetzt neu starten“ klickt
- **THEN** startet nach der Installation Version B, die Session ist `Detached` oder `Running` mit ihrem Bildschirm, und ihr tmux-Prozess hat dieselbe PID wie vorher

#### Scenario: Reihenfolge

- **WHEN** der Nutzer „Jetzt neu starten“ klickt
- **THEN** speichert der Main zuerst das Layout, sendet dann `core.shutdown { stopSessions: false }`, schließt dann die Verbindung und startet erst danach den Installer; der Core wird dabei nicht neu gestartet

#### Scenario: Doppelter Klick oder Beenden läuft

- **GIVEN** ein Beenden der App oder eine Installation läuft schon
- **WHEN** der Nutzer „Jetzt neu starten“ klickt
- **THEN** startet keine zweite Installation und kein zweites `core.shutdown`

### Requirement: Release-Workflow

Ein Push eines Tags `v*` SHALL in GitHub Actions den Installer bauen, den Prüfmodus ausführen und ein Draft-Release zum Tag mit `TermDock-Setup-<version>.exe`, dessen `.blockmap` und `latest.yml` anlegen. Weicht der Tag von `v<version>` aus `apps/desktop/package.json` ab, MUST der Lauf scheitern. Der Workflow MUST nichts veröffentlichen, nur `GITHUB_TOKEN` mit `contents: write` nutzen und Actions mit fester Version (Commit-SHA) einbinden.

#### Scenario: Tag passt zur Version

- **GIVEN** `apps/desktop/package.json` hat Version `0.2.0`
- **WHEN** der Tag `v0.2.0` gepusht wird
- **THEN** gibt es danach ein Draft-Release `v0.2.0` mit den drei Dateien, und kein veröffentlichtes Release ändert sich

#### Scenario: Tag passt nicht

- **GIVEN** `apps/desktop/package.json` hat Version `0.2.0`
- **WHEN** der Tag `v0.3.0` gepusht wird
- **THEN** scheitert der Lauf vor dem Bau, und kein Release entsteht

### Requirement: Integrität ohne Signatur

Die App SHALL unsigniert bleiben; der Updater MUST ohne Prüfung des Herausgebers (`publisherName`) arbeiten und jede geladene Datei gegen die SHA-512 aus `latest.yml` prüfen. Ein Update aus einem Draft-Release MUST für installierte Apps unsichtbar sein, bis der Nutzer es veröffentlicht.

#### Scenario: Beschädigter Download

- **GIVEN** die geladene Datei passt nicht zur SHA-512 in `latest.yml`
- **WHEN** der Download endet
- **THEN** zeigt kein Fenster den Update-Dialog, und der Fehler steht in `desktop.log`
