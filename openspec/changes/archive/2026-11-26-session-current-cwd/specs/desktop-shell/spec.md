## ADDED Requirements

### Requirement: Aktuelles Verzeichnis an alle Fenster

Der Main SHALL `session.cwdChanged` als Brücken-Event `cwdChanged { sessionId, currentCwd? }` an alle Fenster senden, wie Zustandswechsel, je Fenster einmal.

#### Scenario: Weiterleitung an alle Fenster

- **GIVEN** Fenster A zeigt Session `s1`, Fenster B zeigt sie nicht
- **WHEN** der Core `session.cwdChanged { sessionId: "s1", currentCwd: "/tmp" }` meldet
- **THEN** erhalten A und B je einmal `cwdChanged` mit `/tmp`

### Requirement: Aktuelles Verzeichnis im Sessionmodell

Der `UiStore` jedes Fensters SHALL `currentCwd` je Session aus `listSessions` und aus `cwdChanged` (über `sessionCwdChanged`) führen und MUST es entfernen, sobald die Session `Running` und `Detached` verlässt oder ein Event ohne `currentCwd` kommt. Ein Event vor der ersten Liste SHALL wie `stateChanged` gehalten und danach angewendet werden. `currentCwdOf(state, sessionId)` SHALL den Wert liefern, für eine unbekannte Session `undefined`.

#### Scenario: Wert lesen

- **GIVEN** eine laufende Session `s1` im Store
- **WHEN** `cwdChanged` mit `/tmp` kommt
- **THEN** liefert `currentCwdOf(state, "s1")` `/tmp`, und `currentCwdOf(state, "unbekannt")` `undefined`

#### Scenario: Beendete Session

- **GIVEN** eine Session mit `currentCwd: "/tmp"` im Store
- **WHEN** `stateChanged` mit `Exited` kommt, oder ein verspätetes `cwdChanged` mit `/srv` nach dem Ende
- **THEN** hat die Session kein `currentCwd`

#### Scenario: Event vor der Liste

- **GIVEN** das Fenster wartet noch auf `listSessions`
- **WHEN** `cwdChanged` mit `/tmp` für eine laufende Session kommt und danach die Liste ohne Verzeichnis
- **THEN** hat die Session im Store `currentCwd: "/tmp"`
