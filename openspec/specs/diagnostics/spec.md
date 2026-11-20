# diagnostics Specification

## Purpose
Legt fest, wie Core und Desktop-App Diagnose-Logs in `<Datenordner>/logs/` schreiben: Dateien und Zeilenformat, Rotation und Größenbegrenzung, Schwärzung bekannter Geheimnisformen und der Menüeintrag, der den Log-Ordner öffnet.

## Requirements

### Requirement: Core und Desktop schreiben Diagnose-Logs

Der Core SHALL seine Meldungen zusätzlich zu stderr nach `<Datenordner>/logs/core.log` schreiben, der Desktop-Main-Prozess nach `<Datenordner>/logs/desktop.log`, darunter Startfehler des Cores, `coreClosed` und `render-process-gone`. Der Datenordner ist `TERMDOCK_DATA_DIR` oder `%APPDATA%\TermDock`. Eine Zeile SHALL aus ISO-Zeit, Ebene (`info`, `warn`, `error`), Quelle und Text bestehen.

#### Scenario: Startfehler im Core-Log

- **GIVEN** ein Datenordner, dessen `termdock.db` keine Datenbank ist
- **WHEN** der Core startet
- **THEN** endet er mit `start_failed`, und `logs/core.log` enthält nach dem Ende eine Zeile `<Zeit> error core start failed: …` mit der Ursache

#### Scenario: Meldung zu einem Backend

- **GIVEN** ein Core, dessen WSL-Backend beim Abgleich nicht erreichbar ist und der Sessions dieses Backends kennt
- **WHEN** der Abgleich endet
- **THEN** steht in `core.log` eine `warn`-Zeile `backend_unavailable: wsl …`, und derselbe Text geht an stderr

### Requirement: Inhalt und Besitz der Logs

Stacktraces SHALL nur im Log und auf stderr stehen, nie in IPC-Antworten. Der Text einer Zeile SHALL auf 16 KiB gekürzt und die Kürzung markiert werden. Terminal-Ausgabe, Startkommandos und Werte von `launch.env` MUST nie ins Log gelangen, `launch.env`-Werte auch nicht in Fehlerantworten von Core und Brücke; Meldungen tragen nur Session-IDs und Fehlermeldungen. Ein zweiter Core, der mit `already_running` endet, SHALL den Datenordner nicht anlegen und nicht in `core.log` schreiben.

#### Scenario: Überlange Zeile

- **GIVEN** eine Meldung von 32 KiB
- **WHEN** sie geloggt wird
- **THEN** enthält die Zeile die ersten 16 KiB, danach `… [truncated 16384 bytes]`, und kein Mehrbytezeichen ist zerschnitten

#### Scenario: Zweiter Core

- **GIVEN** ein laufender Core
- **WHEN** ein zweiter Core startet und `already_running` meldet
- **THEN** schreibt er nur nach stderr, und `core.log` enthält diese Meldung nicht

#### Scenario: Umgebungswert bei Fehlern

- **GIVEN** ein Profil mit `launch.env { TD_TEST_VALUE: "td-test-secret-0000" }` und Autostart
- **WHEN** Sessions daraus mit fehlendem `cwd`, mit scheiterndem Backend-Start und mit ungültigen Parametern angelegt werden, der Core neu startet und der Autostart scheitert
- **THEN** steht `td-test-secret-0000` in keiner Fehlerantwort von Core und Brücke, in keiner Warnung, nicht in `core.log`, `desktop.log` oder auf stderr, obwohl dort Zeilen zu den Fehlern stehen

### Requirement: Rotation und begrenzte Größe

Jede Log-Datei SHALL ab 1 MiB rotieren: die aktive Datei wird zu `<name>.1.log`, eine ältere Rotation entfällt, so dass je Prozess höchstens zwei Dateien bestehen. Schreiben SHALL asynchron laufen und weder IPC noch PTY blockieren. Schlägt das Schreiben fehl, MUST der Aufrufer davon nichts merken und die App weiterlaufen; der Logger SHALL beim nächsten Schreiben neu beginnen. Scheitert nur die Rotation, SHALL er weiter in die aktive Datei schreiben; die Warteschlange ist begrenzt.
#### Scenario: Rotation gesperrt

- **GIVEN** die Rotation scheitert, weil eine Datei gesperrt ist
- **WHEN** der Logger eine Zeile schreibt
- **THEN** meldet er den Fehler und hängt die Zeile an die aktive Datei an, bis sie das Doppelte der Grenze erreicht

#### Scenario: Warteschlange voll

- **GIVEN** 1000 Zeilen warten auf die Platte
- **WHEN** weitere Zeilen geloggt werden
- **THEN** entfallen sie, und die nächste geschriebene Zeile steht hinter einem `warn`-Vermerk mit ihrer Anzahl

#### Scenario: Rotation an der Grenze

- **GIVEN** ein Logger mit Grenze 250 Bytes und zwei Dateien
- **WHEN** fünf Zeilen zu je 100 Bytes geschrieben werden
- **THEN** besteht `core.log` aus der fünften Zeile, `core.1.log` aus der dritten und vierten, und keine weitere Datei existiert

#### Scenario: Schreibfehler

- **GIVEN** `logs` ist eine Datei statt eines Ordners
- **WHEN** der Logger eine Zeile schreibt
- **THEN** wirft der Aufruf nicht, `onWriteError` wird einmal aufgerufen, stderr erhält die Zeile, und nach Beheben des Ordners landet die nächste Zeile in der Datei

### Requirement: Geheimnisse schwärzen

Vor dem Schreiben SHALL ein gemeinsamer Filter `redact` bekannte Geheimnisformen durch `«redacted»` ersetzen: Werte von Umgebungsvariablen, deren Name `TOKEN`, `SECRET`, `PASSWORD`, `KEY` oder `AUTH` enthält (als `NAME=wert` und als Wert aus der Umgebung des Prozesses), `Authorization: …` bis zum Zeilenende sowie Tokens der Formen `ghp_…`, `github_pat_…`, `sk-…` und `xox…`. Text ohne diese Formen MUST unverändert bleiben. Der Filter SHALL auch Zeilen auf stderr betreffen.

#### Scenario: Token in einer Meldung

- **GIVEN** eine Meldung `clone https://ghp_<36 Zeichen>@example.invalid/x`
- **WHEN** sie geloggt wird
- **THEN** steht in Datei und auf stderr `clone https://«redacted»@example.invalid/x`

#### Scenario: Umgebungsvariable und Header

- **GIVEN** die Meldungen `API_TOKEN=abc123` und `Authorization: Bearer abc.def`
- **WHEN** sie geloggt werden
- **THEN** stehen `API_TOKEN=«redacted»` und `Authorization: «redacted»` im Log

#### Scenario: Gewöhnlicher Text

- **GIVEN** die Meldung `could not save session 3f2a: ENOENT PATH=/usr/bin`
- **WHEN** sie geloggt wird
- **THEN** bleibt sie unverändert

### Requirement: Menüpunkt zum Log-Ordner

Das App-Menü SHALL ein Menü „Hilfe“ mit dem Eintrag „Log-Ordner öffnen“ enthalten. Er SHALL `<Datenordner>/logs` anlegen, falls es fehlt, und im Dateimanager öffnen. Scheitert das, MUST die App weiterlaufen und die Ursache in `desktop.log` stehen.

#### Scenario: Eintrag im Menü

- **GIVEN** das Menü-Template der App
- **WHEN** der Eintrag „Hilfe“ → „Log-Ordner öffnen“ angeklickt wird
- **THEN** öffnet die App den Ordner `<Datenordner>/logs`

#### Scenario: Ordner lässt sich nicht öffnen

- **GIVEN** `shell.openPath` meldet „no application“
- **WHEN** der Eintrag angeklickt wird
- **THEN** wirft nichts, und `desktop.log` enthält `could not open the log folder …: no application`
