# Spec Delta

## Purpose

Legt fest, wie die V1-Abnahmekriterien aus `docs/concept/v1-konzept.txt` (Abschnitt 10) nachgewiesen werden: die Übersicht `docs/acceptance.md`, das Präfix `[V1-<nn>]` in Testnamen und das Prüfskript `scripts/acceptance-check.mjs`, das in der CI läuft.

## ADDED Requirements

### Requirement: Übersicht der V1-Abnahme

`docs/acceptance.md` SHALL für jedes Kriterium des Konzepts eine Zeile in der Übersichtstabelle und einen Abschnitt `### V1-<nn>: <text>` mit dem Text des Konzepts, einer Zeile `Status:` und den Nachweisen haben. Ein Nachweis ist ein Test (Datei und Name), eine Screenshot-Szene (Datei und Bildname) oder ein manueller Schritt. Ein Kriterium ohne Nachweis MUST den Status `offen, #<issue>` tragen.

#### Scenario: Vollständige Übersicht

- **GIVEN** die Kriterien 01–15 des Konzepts und eine Übersicht mit je einem Abschnitt, Nachweisen für 01–14 und `offen, #65` für 15
- **WHEN** `node scripts/acceptance-check.mjs` läuft
- **THEN** endet es mit Code 0 und nennt die Zahl der Kriterien und Nachweise

#### Scenario: Kriterium ohne Nachweis

- **GIVEN** eine Übersicht, in der Kriterium 01 den Status `automatisiert` und keinen Nachweis hat
- **WHEN** das Skript läuft
- **THEN** endet es mit Code 1 und meldet `V1-01: no proof`

#### Scenario: Text weicht ab

- **GIVEN** ein Abschnitt, dessen Text nicht dem Konzept entspricht, oder eine Tabellenzeile mit anderem Status als der Abschnitt
- **WHEN** das Skript läuft
- **THEN** meldet es die Abweichung mit Zeilennummer

### Requirement: Benannte Nachweis-Tests

Ein Test, der ein Kriterium belegt, SHALL im Namen das Präfix `[V1-<nn>]` tragen. Jeder in der Übersicht genannte Test MUST als String-Literal in der genannten Datei stehen und das Präfix seines Kriteriums tragen; jede genannte Szene MUST in ihrer Datei als Bildname in Anführungszeichen stehen. Jeder Test in `packages/` und `apps/` mit `[V1-<nn>]` MUST unter jedem seiner Kriterien genannt sein.

#### Scenario: Umbenannter Test

- **GIVEN** ein Test `[V1-01] does the first thing`, den die Übersicht als `[V1-01] does the frist thing` nennt
- **WHEN** das Skript läuft
- **THEN** meldet es, dass der genannte Test in der Datei fehlt und der echte Test unter V1-01 nicht genannt ist

#### Scenario: Fehlende Datei oder Szene

- **GIVEN** ein Nachweis mit einer Datei, die es nicht gibt, und eine Szene, deren Bildname die Datei nicht enthält
- **WHEN** das Skript läuft
- **THEN** meldet es beide

#### Scenario: Genannter Test ohne Präfix

- **GIVEN** ein Nachweis unter V1-01, dessen Testname kein `[V1-01]` trägt
- **WHEN** das Skript läuft
- **THEN** meldet es das fehlende Präfix

### Requirement: Prüfung in der CI

Der CI-Job `check` SHALL `npm run acceptance` (`node scripts/acceptance-check.mjs`) ausführen und bei einem Fehler scheitern. Die Tests des Skripts MUST Teil von `npm run test:hooks` sein.

#### Scenario: Pull Request mit verwaister Übersicht

- **GIVEN** ein Pull Request, der einen genannten Test umbenennt, ohne `docs/acceptance.md` anzupassen
- **WHEN** die CI läuft
- **THEN** scheitert der Schritt „Acceptance overview“ mit Code 1
