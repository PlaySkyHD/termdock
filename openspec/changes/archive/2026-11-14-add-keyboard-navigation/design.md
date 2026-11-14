# Design

## Context

Nach #26 und #27 hält `ui-store.ts` Tabs und Pane-Baum; `TerminalController` kapselt eine View, `TerminalView` verbindet ihn mit xterm.js 6.0.0. Der Renderer läuft mit `sandbox` und `contextIsolation`; Brückenaufrufe sind eine feste, im Main geprüfte Liste (ADR 0002, 0006). Motivation: proposal.md.

## Goals / Non-Goals

**Goals:** eine Tabelle Befehl → Kürzel, die Phase 3 umbelegen kann; Shell, tmux (`Ctrl+B`) und TUIs behalten jede nicht gebundene Taste; Kopieren und Einfügen ohne neue Brücke.

**Non-Goals:** siehe Proposal.

## Decisions

### Keymap als reines Modul

`keymap.ts` kennt weder DOM noch Electron. `DEFAULT_KEYMAP` bildet jeden `CommandId` auf ein Kürzel wie `Ctrl+Shift+T` ab; `resolveKey(event)` vergleicht `event.code` (physische Taste, layoutunabhängig) und die Modifikatoren exakt (`Meta` und Eingabemethoden-Komposition lösen nie aus). AltGr meldet auf deutschen Layouts Ctrl und Alt zugleich und löst deshalb `Alt+Pfeil` nicht aus. `handleKey(event, run)` liefert „darf das Terminal die Taste verarbeiten“: nein für alle Ereignisse einer gebundenen Taste (keydown, keypress, keyup), ja für den Rest, der unberührt bleibt. Ein gebundenes keydown führt den Befehl einmal aus und ruft `preventDefault` auf, sonst fügte `Ctrl+Shift+V` zusätzlich über das Textfeld von xterm.js ein.

Regel für die Standardbelegung (per Test geprüft): nie `Ctrl+<Buchstabe>` ohne Shift.

### `Ctrl+Shift+N` gehört dem Menü

„Neues Fenster“ ist im Main ein Menüeintrag mit Accelerator. Der Renderer hält die Taste von der Shell fern, ruft aber weder `preventDefault` noch einen Befehl auf, damit das Ereignis den Menü-Accelerator erreicht. Eine Brücken-Methode `newWindow` wäre zusätzliche Angriffsfläche ohne Nutzen.

### Anbindung

Der `TerminalController` bekommt `onCommand` und installiert über die Oberfläche `TerminalSurface.onKey` den Handler (`attachCustomKeyEventHandler`). Ein Listener am Fenster (Phase: Bubble, ignoriert `defaultPrevented`) deckt Sidebar, leeres Fenster und Dialog ab; Kopieren und Einfügen bleiben in Eingabefeldern der Seite (Formular) deren eigene. Befehle laufen in `commands.ts` gegen Store, Controller des aktiven Panes und eine schmale `CommandDeps`-Schnittstelle (Formular, Übersicht, Hinweis, Fokus); `App.tsx` reicht nur diese Funktionen durch.

### Pane-Fokus nach Geometrie

`neighborPane` wählt aus den Rechtecken von `layoutPanes` das Pane, das ganz auf der Seite liegt und ein Stück der Grenze teilt: nächster Abstand, dann längste gemeinsame Strecke, dann Baumreihenfolge. Kein Nachbar am Rand: nichts passiert.

### Zwischenablage ohne Brücke

Eine Sonde (Electron 45.3.1, Fenster mit `sandbox: true`, `contextIsolation: true`, kein Permission-Handler) schrieb und las über `navigator.clipboard` Text mit Umlauten und Zeilenumbruch, mit und ohne User-Geste. Damit genügt der Renderer; ein Brückenaufruf über `clipboard` im Main entfällt. Grenze: Die Seite braucht den Dokumentfokus (er ist da, wenn der Benutzer tippt oder klickt), und ein künftiger `setPermissionRequestHandler` muss `clipboard-read` und `clipboard-write` für die eigene Seite erlauben. Windows liefert Zeilenumbrüche als CRLF; `Terminal.paste` macht daraus CR.

### Einfügen nur in der schreibenden View, Bracketed Paste

`TerminalController.paste(text)` verweigert in Lesern, vor dem Anhängen, nach `coreClosed` und für leeren Text; sonst ruft es `Terminal.paste` auf. In xterm.js 6.0.0 (`lib/xterm.mjs`) ersetzt `paste` `\r?\n` durch `\r` und umschließt den Text mit `ESC [ 200 ~ … ESC [ 201 ~`, wenn `decPrivateModes.bracketedPasteMode` gesetzt ist (die Anwendung sendete `ESC [ ? 2004 h`); das Ergebnis geht durch `triggerDataEvent`, also `onData`, also denselben Weg wie Tippen. Der Controller schreibt deshalb selbst keine Marker. In einem Leser wird die Zwischenablage nicht einmal gelesen; die Statusleiste nennt den Grund. Der Screenshot-Lauf belegt es mit einer echten Shell: zwei eingefügte Zeilen mit Umlauten stehen im Prompt, ohne zu laufen.

tmux schaltet Bracketed Paste am äußeren Terminal genau einmal ein, beim Start seines Clients (Messung mit einem PTY: ein einziges `ESC[?2004h`, auch wenn die Shell es je Prompt aus- und einschaltet), und entfernt oder behält die Marker für das Pane selbst. Dieses eine Signal geht an den Client des Core, lange bevor eine View existiert, und ein Snapshot trägt keine Terminal-Modi. Eine spät angehängte View kennt den Modus also nicht und würde mehrzeiligen Text als getippte Zeilen senden, die laufen. Deshalb schreibt der `TerminalController` bei WSL-Sessions (`bracketedPaste`) nach dem Reset `ESC[?2004h` selbst. Besser wäre ein Modus im Protokoll (tmux kennt `#{bracket_paste_flag}`); das ist ein eigener Change und für das ConPTY-Backend nötig, dessen Anwendungen den Modus selbst senden.

Rechtsklick fügt ein, außer ein Programm hat Mausberichte angefordert (`modes.mouseTrackingMode`, etwa vim mit Maus); mit Shift erzwingt man das Einfügen.

### Übersicht

Dialog statt Menü: Die Accelerator-Anzeige eines Menüs bräuchte einen Weg vom Main in den Renderer. `overviewRows()` liest die Keymap, die neun Tab-Nummern teilen sich eine Zeile.

## Risks / Trade-offs

- `Alt+←/→` sind in manchen Shells Wortsprünge; die Vorgabe des Issues gewinnt, Umbelegen folgt in Phase 3.
- Große Einfügungen gehen als eine `session.input`-Nachricht; eine Grenze oder Zerlegung ist nicht gebaut (offen, falls der Core eine Größe beschränkt).
- `Ctrl+Shift+N` im Screenshot-Lauf nicht per Tastenereignis belegt (Menü-Accelerator).
