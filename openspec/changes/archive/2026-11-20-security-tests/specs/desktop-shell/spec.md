## ADDED Requirements

### Requirement: Escape-Sequenzen nur im Terminal-Emulator

Der Main-Prozess SHALL Terminal-Ausgabe unverändert als `output`-Event an die Fenster der Session geben und MUST auf keine Sequenz reagieren. Die App MUST keinen eigenen OSC-Handler, kein Clipboard-Addon (OSC 52 ist nicht umgesetzt), keinen Link-Öffner, kein `openExternal` und keinen Fenstertitel aus der Ausgabe haben. Ein OSC-8-Link aus xterm.js MUST kein Fenster öffnen und nicht navigieren (`setWindowOpenHandler` verweigert, `will-navigate` verhindert).

#### Scenario: Sequenzen durch die Brücke

- **GIVEN** ein Fenster mit einer View einer Session
- **WHEN** die Session OSC 52, einen OSC-8-Link und Titel-Sequenzen ausgibt
- **THEN** erhält das Fenster genau diese Bytes in `output`-Events und kein anderes Event, die PTY keine Eingabe, und kein Log enthält ihren Inhalt

#### Scenario: Kein Weg aus der Ausgabe

- **GIVEN** die Quellen von Main, Preload, Shared und Renderer
- **WHEN** sie geprüft werden
- **THEN** enthalten sie kein `registerOscHandler`, kein Clipboard- oder Web-Links-Addon, keinen `linkHandler`, kein `onTitleChange`, kein `openExternal` und keinen Import von `clipboard` aus Electron, und `main.ts` verweigert neue Fenster und Navigation
