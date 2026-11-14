# core-ipc Specification

## Purpose
Legt fest, wie der Core Clients über eine lokale Named Pipe bedient: Handshake, Dispatch der Methoden auf die Session Registry, Zuordnung von Views zu Verbindungen, Event-Verteilung, Einzelinstanz, Zugriffsrechte der Pipe, Hello-Frist, Startreihenfolge mit Datenbank und Reconcile, Status, Shutdown und Abbau sowie die Client-Bibliothek.

## Requirements

### Requirement: Handshake als erste Nachricht

Der Core SHALL von jeder Verbindung als erste Nachricht ein gültiges `hello` verlangen und mit seiner `protocolVersion` antworten. Jede andere erste Nachricht MUST mit `bad_request` beantwortet und die Verbindung abgebaut werden. Bei abweichender Hauptversion SHALL der Core mit `protocol_mismatch` antworten und die Verbindung abbauen.

#### Scenario: Erfolgreicher Handshake

- **GIVEN** ein Client mit gleicher Hauptversion
- **WHEN** er `hello` sendet
- **THEN** antwortet der Core mit seiner `protocolVersion` und nimmt weitere Anfragen an

#### Scenario: Andere erste Nachricht

- **GIVEN** eine frisch aufgebaute Verbindung
- **WHEN** der Client `session.list` statt `hello` sendet
- **THEN** antwortet der Core mit `bad_request` und baut die Verbindung ab

#### Scenario: Falsche Hauptversion

- **GIVEN** ein Client mit Protokollversion `2.0`
- **WHEN** er `hello` sendet
- **THEN** antwortet der Core mit `protocol_mismatch` und baut die Verbindung ab

### Requirement: Dispatch auf die Registry und Fehlerabbildung

Der Core SHALL die Methoden `session.create`, `session.list`, `session.attach`, `session.detach`, `session.input`, `session.resize`, `session.claimWriter` und `session.kill` auf die Session Registry abbilden. Ein `CoreError` MUST mit seinem `code` als `error.code` beantwortet werden; jeder andere Fehler MUST als `internal` ohne Stacktrace beantwortet werden. Ungültige Anfragen (Guard-Fehler) MUST mit `bad_request` beantwortet werden, ohne die Verbindung abzubauen.

#### Scenario: Session anlegen und auflisten

- **GIVEN** ein verbundener Client
- **WHEN** er `session.create` und danach `session.list` sendet
- **THEN** enthält die Liste die neue Session

#### Scenario: Registry-Fehler

- **GIVEN** ein verbundener Client
- **WHEN** er `session.kill` für eine unbekannte Session sendet
- **THEN** antwortet der Core mit `not_found`

#### Scenario: Unbekannter Fehler

- **GIVEN** die Registry wirft einen Fehler ohne Code
- **WHEN** eine Anfrage ihn auslöst
- **THEN** antwortet der Core mit `internal` und einer Meldung ohne Stacktrace

### Requirement: Views gehören zur Verbindung

`session.attach` SHALL eine View für die anfragende Verbindung anlegen, deren `viewId` der Core vergibt, und den Snapshot als Nutzdaten liefern. Eine Verbindung SHALL nur ihre eigenen Views benutzen, ändern oder abhängen können; fremde oder unbekannte `viewId` MUST mit `not_found` beantwortet werden. Trennt sich eine Verbindung, SHALL der Core alle ihre Views abhängen; die Sessions laufen weiter und ein Schreiber verliert sein Recht.

#### Scenario: Zwei Clients, ein Schreiber

- **GIVEN** zwei Clients mit je einer View derselben Session, die erste View schreibt
- **WHEN** der zweite Client `session.input` oder `session.resize` sendet
- **THEN** antwortet der Core mit `not_writer`, und beim ersten Client kommen Eingabe und Resize an

#### Scenario: Fremde View

- **GIVEN** zwei verbundene Clients, der erste mit einer View
- **WHEN** der zweite Client `session.detach` mit der `viewId` des ersten sendet
- **THEN** antwortet der Core mit `not_found` und die View bleibt angehängt

#### Scenario: Client bricht ab

- **GIVEN** ein Client, der Schreiber einer laufenden Session ist
- **WHEN** seine Verbindung abbricht
- **THEN** läuft die Session weiter, hat keinen Schreiber mehr und ein anderer Client kann das Schreibrecht übernehmen

### Requirement: Event-Verteilung

Der Core SHALL `session.output`, `session.resized` und `view.writerChanged` nur an Verbindungen senden, die eine View der Session haben, je Event höchstens einmal je Verbindung. `session.stateChanged` SHALL zusätzlich an Verbindungen gehen, die `session.list` genutzt haben. Ausgabe über der Nutzdatengrenze SHALL in mehrere Events geteilt werden.

#### Scenario: Ausgabe an alle Views

- **GIVEN** zwei Clients mit Views derselben Session
- **WHEN** die Session Ausgabe erzeugt
- **THEN** erhalten beide Clients ein `session.output` mit denselben Bytes

#### Scenario: Unbeteiligter Client

- **GIVEN** ein dritter Client ohne View und ohne `session.list`
- **WHEN** die Session Ausgabe erzeugt oder ihren Zustand wechselt
- **THEN** erhält er kein Event

#### Scenario: Zustandswechsel an Listenclient

- **GIVEN** ein Client, der `session.list` genutzt hat, ohne View
- **WHEN** die Session ihren Zustand wechselt
- **THEN** erhält er `session.stateChanged`

### Requirement: Event-Reihenfolge beim Attach

Ein Event für eine View MUST nach der Attach-Antwort dieser View eintreffen. Events, die während eines laufenden Attach für die Verbindung anfallen, MUST in ihrer Reihenfolge ausgeliefert werden, auch wenn der Attach fehlschlägt.

#### Scenario: Fehlgeschlagener Attach verliert keine Events

- **GIVEN** ein Client, der `session.list` genutzt hat und dessen `session.attach` noch läuft
- **WHEN** die Session archiviert wird und der Attach deshalb mit `invalid_state` scheitert
- **THEN** erhält der Client trotzdem `session.stateChanged` mit `Archived`

### Requirement: Backpressure

Der Core SHALL je Verbindung die noch nicht abgenommene Ausgabe auf eine Obergrenze begrenzen. Liest ein Client nicht ab und überschreitet die Grenze, SHALL der Core die Verbindung trennen und ihre Views abhängen; andere Clients und die Sessions bleiben unberührt.

#### Scenario: Langsamer Client

- **GIVEN** ein Client mit View, der nicht liest, und eine kleine Obergrenze
- **WHEN** die Session mehr Ausgabe erzeugt als die Grenze
- **THEN** trennt der Core diesen Client, seine View ist abgehängt und die Session läuft weiter

### Requirement: Einzelinstanz

Der Core SHALL die Pipe exklusiv belegen (Pfad konfigurierbar). Ist sie belegt, SHALL der Start mit dem Fehlercode `already_running` scheitern, bevor die Datenbank geöffnet wird; der Einstiegsprozess SHALL sich mit Exit-Code 10 und einer Meldung auf stderr beenden. Der laufende Core MUST davon unberührt bleiben.

#### Scenario: Zweite Instanz

- **GIVEN** ein laufender Core auf einer Pipe
- **WHEN** ein zweiter Core dieselbe Pipe belegen will
- **THEN** scheitert er mit `already_running`, Exit-Code 10 und einer stderr-Meldung, und der erste Core antwortet weiter

#### Scenario: Zweite Instanz öffnet keine Datenbank

- **GIVEN** ein laufender Core auf einer Pipe
- **WHEN** ein zweiter Core mit einem noch nicht vorhandenen Datenverzeichnis dieselbe Pipe belegen will
- **THEN** scheitert er mit `already_running` und das Datenverzeichnis bleibt unangelegt

### Requirement: Pipe-Name pro Konto

Der Pipe-Name SHALL `\\.\pipe\termdock-core-<benutzer>-<hash>` lauten. `<benutzer>` ist der für Pipe-Namen bereinigte Benutzername, `<hash>` sind 12 Hex-Zeichen von SHA-256 über `<Domäne>\<Benutzername>` im Rohzustand (Domäne aus `USERDOMAIN`, sonst Rechnername). Konten, deren bereinigte Namen gleich sind oder die sich nur in der Domäne unterscheiden, MUST verschiedene Pipes haben.

#### Scenario: Konten mit gleichem bereinigtem Namen

- **GIVEN** die Konten `PC\Jörg` und `PC\Jürg` sowie `DOMAIN\bob` und `PC\bob`
- **WHEN** ihre Pipe-Namen gebildet werden
- **THEN** sind alle Namen verschieden

### Requirement: Shutdown

`core.shutdown { stopSessions }` SHALL den Core beenden und danach die Pipe schließen. Ab der ersten Shutdown-Anfrage MUST der Core alle anderen Anfragen mit `invalid_state` ablehnen. Mit `stopSessions: true` SHALL der Core zuvor alle Sessions beenden, auch solche in `Starting` (nach einer Frist); sonst lässt er die Sessions unberührt.

#### Scenario: Shutdown mit Stop

- **GIVEN** zwei laufende Sessions
- **WHEN** ein Client `core.shutdown { stopSessions: true }` sendet
- **THEN** sind beide Sessions `Exited`, der Client erhält die Antwort und die Pipe ist geschlossen

#### Scenario: Shutdown ohne Stop

- **GIVEN** eine laufende Session
- **WHEN** ein Client `core.shutdown { stopSessions: false }` sendet
- **THEN** bleibt die Session unverändert, und die Pipe ist geschlossen

#### Scenario: Session in Starting

- **GIVEN** eine Session in `Starting` und ein laufender `core.shutdown { stopSessions: true }`
- **WHEN** eine weitere Anfrage eintrifft und danach der Start abgeschlossen wird
- **THEN** wird die weitere Anfrage mit `invalid_state` abgelehnt und die Session am Ende `Exited`

### Requirement: Shutdown-Fehler und mehrere Shutdown-Anfragen

Scheitert das Beenden einzelner Sessions, SHALL die Antwort ein Fehler sein, dessen Meldung die nicht beendeten Session-IDs nennt; die übrigen Sessions werden trotzdem beendet und der Core schließt. Mehrere Shutdown-Anfragen SHALL zusammengeführt werden: `stopSessions` gilt, wenn eine von ihnen es verlangt, und jede MUST beantwortet werden, bevor der Server schließt.

#### Scenario: Beenden schlägt fehl

- **GIVEN** zwei laufende Sessions, bei einer scheitert das Beenden
- **WHEN** ein Client `core.shutdown { stopSessions: true }` sendet
- **THEN** antwortet der Core mit einem Fehler, dessen Meldung die nicht beendete Session-ID nennt, die andere Session ist `Exited` und die Pipe ist geschlossen

#### Scenario: Zwei Shutdown-Anfragen

- **GIVEN** zwei Clients
- **WHEN** der erste `core.shutdown {}` und kurz danach der zweite `core.shutdown { stopSessions: true }` sendet
- **THEN** werden beide beantwortet und alle Sessions sind `Exited`

### Requirement: Client-Bibliothek

Die Client-Bibliothek SHALL mit `connect(pipe)` verbinden und den `hello`-Handshake ausführen, typisierte Anfragen mit Zeitüberschreitung senden, Events an Listener liefern und mit `close()` alle Ressourcen freigeben. Fehlerantworten SHALL als Fehler mit dem Core-Fehlercode abgewiesen werden; bei Zeitüberschreitung oder geschlossener Verbindung SHALL der Code `timeout` bzw. `closed` lauten.

#### Scenario: Zeitüberschreitung

- **GIVEN** ein Server, der nicht antwortet
- **WHEN** eine Anfrage das Zeitlimit überschreitet
- **THEN** wird sie mit Code `timeout` abgewiesen

#### Scenario: Verbindung geht verloren

- **GIVEN** eine offene Anfrage
- **WHEN** der Server die Verbindung schließt
- **THEN** wird die Anfrage mit Code `closed` abgewiesen

### Requirement: Fehler in Event-Listenern

Eine Ausnahme in einem Event-Listener der Client-Bibliothek MUST weder andere Listener noch die Verarbeitung folgender Nachrichten stoppen; sie SHALL an einen optionalen Fehler-Rückruf (Standard `console.error`) gemeldet werden.

#### Scenario: Listener wirft

- **GIVEN** ein Listener, der bei jedem Event eine Ausnahme wirft, und ein zweiter Listener
- **WHEN** zwei Events nacheinander eintreffen
- **THEN** erhält der zweite Listener beide Events, der Fehler-Rückruf wird zweimal aufgerufen und weitere Anfragen funktionieren

### Requirement: Zugriffsrechte der Pipe

Kein Konto außer dem Benutzer des Core, SYSTEM und den Administratoren SHALL Schreibzugriff auf die Pipe haben. Fremde Konten dürfen die Pipe höchstens lesend öffnen (Windows gewährt Everyone und Anonymous Lesezugriff auf Pipes ohne eigenen Sicherheitsdeskriptor); sie können keine Anfrage senden und erhalten keine Events oder Nutzdaten. Ein Windows-Test MUST die DACL der erzeugten Pipe prüfen.

#### Scenario: DACL der Core-Pipe

- **GIVEN** ein gestarteter Core auf einer Pipe (Windows)
- **WHEN** die DACL der Pipe gelesen wird
- **THEN** hat der aktuelle Benutzer Vollzugriff, und kein anderer Trustee außer SYSTEM und Administratoren hat Schreibrecht

#### Scenario: Core mit erhöhtem Token

- **GIVEN** ein Core, der mit erhöhtem Administrator-Token läuft (z. B. GitHub-Runner)
- **WHEN** die DACL der Pipe gelesen wird
- **THEN** hält statt des Benutzers die Gruppe Administratoren den Vollzugriff, und kein anderer Trustee hat Schreibrecht

### Requirement: Grenze für Verbindungen ohne Handshake

Der Core SHALL höchstens 32 Verbindungen gleichzeitig ohne abgeschlossenes `hello` halten (konfigurierbar, ganzzahlig und mindestens 1). Weitere neue Verbindungen MUST sofort ohne Antwort abgebaut werden. Ein Platz wird frei, sobald `hello` abgeschlossen ist oder die Verbindung schließt.

#### Scenario: Grenze erreicht

- **GIVEN** eine Grenze von 2 und zwei Verbindungen ohne `hello`
- **WHEN** eine dritte Verbindung aufgebaut wird
- **THEN** baut der Core sie sofort ab, die ersten beiden bleiben offen, und nach einem `hello` oder Schließen wird eine neue Verbindung wieder angenommen

### Requirement: Frist für den Handshake

Der Core SHALL eine Verbindung abbauen, die nicht innerhalb von 5 Sekunden nach dem Aufbau ein gültiges `hello` abgeschlossen hat. Die Frist ist konfigurierbar, muss aber eine positive endliche Zahl sein; sonst MUST der Start mit einem Fehler scheitern (es gibt kein „aus“). Der Timer MUST mit dem erfolgreichen `hello` und beim Schließen der Verbindung enden; eine Verbindung nach `hello` bleibt unbegrenzt offen.

#### Scenario: Verbindung ohne hello

- **GIVEN** eine frisch aufgebaute Verbindung, die nichts sendet
- **WHEN** die Frist abläuft
- **THEN** baut der Core die Verbindung ab, ohne etwas zu senden

#### Scenario: Verbindung nach hello

- **GIVEN** ein Client, der `hello` innerhalb der Frist abgeschlossen hat
- **WHEN** die Frist verstrichen ist
- **THEN** bleibt die Verbindung offen und beantwortet weitere Anfragen

### Requirement: Startreihenfolge des Core

Der Core SHALL beim Start zuerst die Pipe belegen, danach die Datenbank im Datenverzeichnis öffnen (Option, sonst `TERMDOCK_DATA_DIR` bzw. `%APPDATA%\TermDock`), das WSL-Backend auf dem tmux-Socket `termdock` (per Option änderbar) registrieren und die gespeicherten Sessions abgleichen. Den `hello`-Handshake SHALL er sofort beantworten; jede weitere Anfrage MUST bis zum Ende des Abgleichs warten.

#### Scenario: Anfrage während des Abgleichs

- **GIVEN** ein Core, dessen Abgleich noch läuft, und ein verbundener Client
- **WHEN** der Client `session.list` sendet
- **THEN** kommt die Antwort erst nach dem Abgleich und enthält die abgeglichenen Zustände

#### Scenario: Neustart mit derselben Datenbank

- **GIVEN** ein Core, der eine Session angelegt hat und ohne Stop beendet wurde
- **WHEN** ein neuer Core mit demselben Datenverzeichnis startet
- **THEN** liefert `session.list` die Session mit derselben ID im abgeglichenen Zustand

### Requirement: Gescheiterter Start nach dem Belegen der Pipe

Scheitert das Öffnen der Datenbank oder der Abgleich, SHALL der Core wartende Anfragen mit `internal` beantworten, die Pipe schließen und sich mit Exit-Code 1 und einer Meldung auf stderr beenden.

#### Scenario: Datenbank lässt sich nicht öffnen

- **GIVEN** ein Datenverzeichnis, in dem die Datenbank nicht geöffnet werden kann
- **WHEN** der Core startet
- **THEN** endet der Start mit `start_failed` und Exit-Code 1, stderr nennt den Grund und die Pipe ist frei

### Requirement: Status des Core

`core.status` SHALL die Backends nennen, die beim Abgleich nicht erreichbar waren (`backendUnavailable`, leer, wenn alle erreichbar waren). Der Core MUST jedes nicht erreichbare Backend außerdem beim Start auf stderr melden.

#### Scenario: WSL beim Start nicht erreichbar

- **GIVEN** eine gespeicherte WSL-Session in `Running` und ein WSL-Backend, das nicht verfügbar ist
- **WHEN** der Core startet und ein Client `core.status` sendet
- **THEN** enthält `backendUnavailable` den Wert `wsl`, stderr meldet `backend_unavailable` und die Session ist `Interrupted`

### Requirement: Abbau des Core

Bei `core.shutdown`, SIGINT und SIGTERM SHALL der Core die Pipe schließen, alle PTYs lösen, ohne Zustände zu ändern, die Keepalives des WSL-Backends beenden und die Datenbank schließen. Ein Signal während des Abgleichs MUST diesen abbrechen und ebenso abbauen. Ohne `stopSessions` MUST jede tmux-Session weiterlaufen; mit `stopSessions` werden die Sessions vorher beendet, auch solche, die gerade wieder angebunden werden.

#### Scenario: Beenden ohne Stop

- **GIVEN** ein Core mit einer laufenden WSL-Session
- **WHEN** er ohne Stop beendet wird
- **THEN** existiert die tmux-Session weiter, kein Keepalive-Prozess des Core läuft mehr und die Datenbank ist geschlossen

#### Scenario: Signal während des Abgleichs

- **GIVEN** ein Core, dessen Abgleich noch auf das Backend wartet
- **WHEN** SIGTERM eintrifft
- **THEN** endet der Core mit Exit-Code 0, die Pipe ist frei, die Datenbank ist geschlossen und der gespeicherte Zustand der Session ist unverändert

#### Scenario: Shutdown während des Wiederanbindens

- **GIVEN** eine Session, deren Client verloren ging und die gerade wieder angebunden wird
- **WHEN** ein Client `core.shutdown { stopSessions: true }` sendet
- **THEN** antwortet der Core ohne Fehler und die Session ist `Exited`

### Requirement: Event für neue Sessions

Der Core SHALL nach dem Eintragen einer Session durch `session.create` das Event `session.created` mit der Session im Zustand `Starting` an jede Verbindung senden, die `session.list` genutzt hat (wie `session.stateChanged`), auch an die anfragende, einmal je Verbindung. Es MUST vor der Antwort und vor jedem `session.stateChanged` der Session eintreffen. Vor dem Eintragen abgelehnt (`bad_request`, Shutdown, Speicherfehler) oder beim Laden gespeicherter Sessions SHALL der Core es nicht senden.

#### Scenario: Zweiter Client sieht die neue Session

- **GIVEN** Client A und Client B sind verbunden und haben `session.list` genutzt, Client C nicht
- **WHEN** A `session.create` aufruft
- **THEN** erhält B `session.created` mit der neuen Session, A erhält es vor der Antwort, C erhält es nicht

#### Scenario: Abgelehnte Anfrage

- **GIVEN** zwei verbundene Clients, die `session.list` genutzt haben
- **WHEN** `session.create` vor dem Eintragen mit `bad_request` abgelehnt wird
- **THEN** erhält kein Client ein `session.created`

#### Scenario: Start scheitert

- **GIVEN** ein Client, der `session.list` genutzt hat, und ein nicht erreichbarer Backend-Start
- **WHEN** ein anderer Client `session.create` aufruft und mit `backend_unavailable` eine Absage erhält
- **THEN** erhält der erste Client `session.created` im Zustand `Starting` und danach `session.stateChanged` mit `Interrupted`

#### Scenario: Gespeicherte Sessions beim Start

- **GIVEN** gespeicherte Sessions und ein Core, der sie beim Start lädt
- **WHEN** der Reconcile abgeschlossen ist
- **THEN** wurde für keine davon `session.created` gesendet; Clients lesen sie mit `session.list`

### Requirement: Platzhalter für Methoden der Phase 3

Bis ihre Fachlogik umgesetzt ist, SHALL der Core jede noch nicht umgesetzte Methode der Phase 3 (`session.update`, `session.archive`, `session.delete`, `settings.*`, `history.search`) mit dem Fehler `internal` beantworten, dessen Meldung die Methode und „noch nicht umgesetzt“ nennt. `workspace.*`, `project.*` (Capability `workspaces`) und `profile.*` (Capability `launch-profiles`) sind umgesetzt. Die Verbindung MUST offen bleiben und der Core MUST weiter Anfragen bedienen.

#### Scenario: Stub antwortet mit Fehler

- **GIVEN** ein verbundener Client
- **WHEN** er nacheinander jede noch nicht umgesetzte Methode der Phase 3 mit gültigen Parametern aufruft
- **THEN** antwortet der Core jeweils mit `internal` und „noch nicht umgesetzt“, und danach gelingt `session.list` auf derselben Verbindung

### Requirement: Empfänger der Phase-3-Events

Der Core SHALL `session.updated`, `session.removed`, `workspace.changed`, `profile.changed` und `settings.changed` wie `session.created` an jede Verbindung senden, die `session.list` genutzt hat, auch an die auslösende, je Event höchstens einmal je Verbindung. Verbindungen ohne `session.list` MUST sie nicht erhalten.

#### Scenario: Event an Listen-Clients

- **GIVEN** ein Client, der `session.list` genutzt hat, und einer, der es nicht hat
- **WHEN** der Core `workspace.changed` sendet
- **THEN** erhält nur der erste Client das Event, genau einmal
