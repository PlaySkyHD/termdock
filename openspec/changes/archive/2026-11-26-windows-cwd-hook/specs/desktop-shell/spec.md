# Spec Delta

## MODIFIED Requirements

### Requirement: Escape-Sequenzen nur im Terminal-Emulator

Der Main-Prozess SHALL Terminal-Ausgabe unverändert als `output`-Event an die Fenster der Session geben und MUST auf keine Sequenz reagieren. Die App MUST keinen eigenen OSC-Handler außer dem für OSC 9 (Verzeichnis der Windows-Shell), kein Clipboard-Addon (OSC 52 ist nicht umgesetzt), keinen Link-Öffner, kein `openExternal` und keinen Fenstertitel aus der Ausgabe haben. Ein OSC-8-Link aus xterm.js MUST kein Fenster öffnen und nicht navigieren (`setWindowOpenHandler`, `will-navigate` verweigern).

#### Scenario: Sequenzen durch die Brücke

- **GIVEN** ein Fenster mit einer View einer Session
- **WHEN** die Session OSC 52, einen OSC-8-Link und Titel-Sequenzen ausgibt
- **THEN** erhält das Fenster genau diese Bytes in `output`-Events und kein anderes Event, die PTY keine Eingabe, und kein Log enthält ihren Inhalt

#### Scenario: Kein Weg aus der Ausgabe

- **GIVEN** die Quellen von Main, Preload, Shared und Renderer
- **WHEN** sie geprüft werden
- **THEN** enthalten sie kein `registerOscHandler` für eine andere Nummer als 9, kein Clipboard- oder Web-Links-Addon, keinen `linkHandler`, kein `onTitleChange`, kein `openExternal` und keinen Import von `clipboard` aus Electron, und `main.ts` verweigert neue Fenster und Navigation

## ADDED Requirements

### Requirement: Aktuelles Verzeichnis einer Windows-Session aus OSC 9;9

Der Terminal-Controller SHALL über den OSC-Parser von xterm.js (`registerOscHandler(9, …)`) das Verzeichnis lesen, das der Prompt-Hook der Windows-Shell sendet (`9;"<pfad>"` oder `9;<pfad>`), und es als `currentCwd()` anbieten. `onCwd(listener)` MUST bei jeder Änderung des Pfades melden und eine Funktion zum Abmelden liefern. Ein anderer OSC 9 (Benachrichtigung, Fortschritt) MUST der Handler mit `false` weitergeben. Beim Anhängen läuft der Snapshot durch denselben Parser.

#### Scenario: Pfad aus der Ausgabe

- **GIVEN** eine angehängte View einer Windows-Session und ein Listener über `onCwd`
- **WHEN** die Ausgabe `ESC ] 9 ; 9 ; "C:\Windows" ESC \` zweimal und danach `ESC ] 9 ; 9 ; "D:\work dir" ESC \` bringt
- **THEN** meldet der Listener `C:\Windows` einmal und `D:\work dir` einmal, und `currentCwd()` ist `D:\work dir`

#### Scenario: Pfad aus dem Snapshot

- **GIVEN** ein Snapshot mit zwei Meldungen, zuletzt `\\server\share\dir`
- **WHEN** die View anhängt
- **THEN** ist `currentCwd()` `\\server\share\dir`

#### Scenario: Benachrichtigung bleibt

- **GIVEN** eine angehängte View
- **WHEN** die Ausgabe `ESC ] 9 ; Build finished ESC \` enthält
- **THEN** gibt der Handler `false` zurück, und `currentCwd()` ändert sich nicht

#### Scenario: Abbau

- **GIVEN** ein abgemeldeter Listener und ein Controller, der danach `dispose` ruft
- **WHEN** weitere Meldungen eintreffen
- **THEN** wird kein Listener mehr gerufen, und der OSC-Handler ist beim Terminal entfernt

### Requirement: Prüfung des gemeldeten Verzeichnisses

Die reine Funktion `parseCwdOsc` SHALL einen gemeldeten Pfad nur annehmen, wenn er absolut ist (`X:\`, `X:/` oder UNC), höchstens 512 Zeichen hat und kein Steuerzeichen (C0, DEL, C1) enthält. Sonst MUST die Meldung verworfen werden und der letzte gute Pfad bleiben, ohne dass ein Listener gerufen wird. Terminal-Ausgabe ist Daten: Der Pfad wird nie ausgeführt.

#### Scenario: Ungültiger Pfad

- **GIVEN** ein gemeldeter Pfad `C:\good`
- **WHEN** danach Meldungen mit einem Steuerzeichen im Pfad, mit `relative\dir` und mit 600 Zeichen eintreffen
- **THEN** bleibt `currentCwd()` `C:\good`, und kein Listener wird gerufen
