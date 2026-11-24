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

Ist ein Update geladen, SHALL jedes Fenster unten rechts einen nicht-modalen Dialog zeigen: „Update auf Version <v> ist bereit.“, „Jetzt neu starten“ und „Später“. Er MUST den Fokus nicht aus dem Terminal nehmen. Laufen Windows-Shells (`Running` oder `Detached`), MUST er sagen, dass sie mit dem Neustart enden; WSL-Sessions SHALL er als weiterlaufend nennen. „Später“ SHALL ihn in allen Fenstern ausblenden; diese Version kommt erst nach dem nächsten Start wieder, eine neuere sofort.

#### Scenario: Update mit laufender Windows-Shell

- **GIVEN** ein geladenes Update 0.2.0, eine WSL-Session und eine Windows-Shell laufen
- **WHEN** das Fenster den Dialog zeigt
- **THEN** nennt er Version 0.2.0, dass WSL-Sessions weiterlaufen und dass die Windows-Shell beim Neustart endet
- **AND** das Terminal behält den Fokus

#### Scenario: Später

- **GIVEN** zwei Fenster zeigen den Dialog
- **WHEN** der Nutzer in einem „Später“ klickt
- **THEN** verschwindet er in beiden, und bis zum nächsten Start der App erscheint er für diese Version nicht wieder
- **AND** lädt eine spätere Suche im selben Lauf eine neuere Version, zeigen beide Fenster den Dialog für sie

#### Scenario: Später geöffnetes Fenster

- **GIVEN** ein geladenes Update, das noch nicht abgelehnt ist
- **WHEN** ein neues Fenster lädt
- **THEN** zeigt es den Dialog ebenfalls

### Requirement: Installation mit überlebenden tmux-Sessions

„Jetzt neu starten“ SHALL das Layout speichern, den Core mit `core.shutdown { stopSessions: false }` beenden (tmux-Sessions und WSL-Keepalive bleiben, Windows-Shells enden), die Verbindung schließen, den Installer still starten und die App beenden (startet er nicht, startet sie neu). Während eines Beendens oder Core-Neustarts MUST der Klick nichts tun und das Angebot bleiben. Danach SHALL der neue Core abgleichen und die WSL-Sessions wieder anbinden.

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

#### Scenario: Core startet gerade neu

- **GIVEN** der Core startet nach einem Absturz neu oder die Neustarts haben aufgegeben (#130)
- **WHEN** der Nutzer „Jetzt neu starten“ klickt
- **THEN** sendet der Main kein `core.shutdown`, installiert nichts, und alle Fenster zeigen den Dialog wieder

#### Scenario: Installer startet nicht

- **GIVEN** die geladene Datei ist vor dem Klick verschwunden
- **WHEN** der Nutzer „Jetzt neu starten“ klickt
- **THEN** beendet sich die App nach dem Ende des Core und startet sich selbst neu; der nächste Start bietet das Update wieder an

### Requirement: Release-Workflow

Ein Tag `v*` SHALL den Installer bauen, den Prüfmodus ausführen und ein Draft-Release mit `TermDock-Setup-<version>.exe`, `.blockmap` und `latest.yml` anlegen. Weicht der Tag von `v<version>` ab oder liegt sein Commit nicht auf `main`, MUST der Lauf scheitern. Er MUST nichts veröffentlichen, nur `GITHUB_TOKEN` und Actions per Commit-SHA nutzen; der Bau läuft mit `contents: read`, ohne gespeicherten Token und npm-Cache, nur ein Job ohne Checkout hat `contents: write`.

#### Scenario: Tag passt zur Version

- **GIVEN** `apps/desktop/package.json` hat Version `0.2.0`
- **WHEN** der Tag `v0.2.0` gepusht wird
- **THEN** gibt es danach ein Draft-Release `v0.2.0` mit den drei Dateien, und kein veröffentlichtes Release ändert sich

#### Scenario: Tag passt nicht

- **GIVEN** `apps/desktop/package.json` hat Version `0.2.0`
- **WHEN** der Tag `v0.3.0` gepusht wird
- **THEN** scheitert der Lauf vor dem Bau, und kein Release entsteht

#### Scenario: Tag außerhalb von main

- **GIVEN** ein Tag `v0.2.0` auf einem Commit, der nur auf einem anderen Branch liegt
- **WHEN** er gepusht wird
- **THEN** scheitert der Lauf vor dem Bau, und kein Release entsteht

#### Scenario: Rechte der Jobs

- **GIVEN** `.github/workflows/release.yml`
- **WHEN** der Test die Datei liest
- **THEN** checkt der Bau-Job mit `persist-credentials: false` aus, hat `contents: read` und kein `cache: npm`, und nur der Job, der `gh release create` aufruft, hat `contents: write` und checkt nichts aus

### Requirement: Integrität ohne Signatur

Die App SHALL unsigniert bleiben; der Updater MUST ohne Prüfung des Herausgebers (`publisherName`) arbeiten und jede geladene Datei gegen die SHA-512 aus `latest.yml` prüfen. Ein Update aus einem Draft-Release MUST für installierte Apps unsichtbar sein, bis der Nutzer es veröffentlicht.

#### Scenario: Beschädigter Download

- **GIVEN** die geladene Datei passt nicht zur SHA-512 in `latest.yml`
- **WHEN** der Download endet
- **THEN** zeigt kein Fenster den Update-Dialog, und der Fehler steht in `desktop.log`
