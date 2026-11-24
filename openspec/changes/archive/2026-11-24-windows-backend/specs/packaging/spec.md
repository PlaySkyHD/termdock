## ADDED Requirements

### Requirement: Prüfmodus startet eine Windows-Shell

Nach `core.status` SHALL der Prüfmodus im eigenen Core `cmd.exe /d /c exit 23` als Windows-Session (Argument-Array) starten, höchstens 15 s auf `Exited` mit Code 23 warten und die Session löschen. Scheitert das, MUST er den Grund loggen, den Core beenden und mit Code 1 enden. In einem fremden Core MUST er keine Session anlegen.

#### Scenario: Paket mit ConPTY

- **GIVEN** die entpackte App und `TERMDOCK_DATA_DIR` auf einem leeren Temp-Ordner, ohne WSL
- **WHEN** sie mit `--smoke-test` startet
- **THEN** loggt sie „Windows shell started and ended with its exit code“ und endet mit Code 0

#### Scenario: Shell endet anders

- **GIVEN** die Session endet mit einem anderen Code, wird `Interrupted` oder endet nicht in 15 s
- **WHEN** die Prüfung läuft
- **THEN** loggt sie „smoke test failed: Windows shell: <grund>“, beendet den Core und endet mit Code 1
