## MODIFIED Requirements

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
