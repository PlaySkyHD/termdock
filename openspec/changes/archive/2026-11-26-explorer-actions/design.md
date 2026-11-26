# Design

## Context

Das Panel (#202) hält einen reinen Baum (`explorer-tree.ts`) in einer Ref und ruft `window.termdock.files`. Der Dateidienst (ADR 0009) prüft jeden Ort, lehnt geschützte Orte mit `EINVAL` ab, überschreibt nie (`EEXIST`) und antwortet mit Ergebnissen statt Ausnahmen. Das Sidebar-Menü (`ContextMenu.tsx`, `menu-navigation.ts`, `MenuEntry` aus `sidebar-model.ts`), der Rückfrage-Dialog (`ConfirmDialog` in `Dialogs.tsx`, Fokusfalle) und Drag&Drop mit Abbruch (`renderer/drag/`) gibt es schon. Einfügen ins Terminal geht durch `TerminalController.paste` (Bracketed Paste, nur im Schreiber, ADR 0006).

## Goals / Non-Goals

**Goals:**

- Jede Aktion, die der Dienst kann, ist mit Maus und Tastatur erreichbar.
- Löschen passiert nie ohne Rückfrage.
- Ein eingefügter Pfad erzeugt in keiner Shell einen zweiten Befehl oder ein Enter.
- Die Regeln sind reine Funktionen mit Tests; das `.tsx` ruft sie nur auf.

**Non-Goals:**

- Papierkorb, Kopieren, Neuer Ordner, Mehrfachauswahl, Ziehen zwischen Fenstern oder ins Terminal.

## Decisions

### Ein Modul für die Regeln der Aktionen

`explorer-actions.ts` enthält:

- `isProtectedPath(location)`: dieselbe Regel wie `isProtected` im Main (Wurzel, alles direkt unter `/` und `/mnt`, alles direkt unter `/mnt/wsl`, ein Laufwerk). Der Renderer kann `main/file-paths.ts` nicht laden (es nutzt `node:path`), deshalb eine eigene Fassung mit denselben Testfällen. Der Main bleibt die Grenze; die Fassung im Renderer blendet nur Einträge aus.
- `explorerMenu(row, location, context)`: die Einträge je Backend und Typ. Reihenfolge Öffnen, Herunterladen, Im Windows-Explorer zeigen | Pfad kopieren, Pfad ins Terminal einfügen | Umbenennen, Löschen. „Pfad ins Terminal einfügen“ ist deaktiviert ohne Schreiber oder bei einem Pfad mit Steuerzeichen, mit Grund im Tooltip. Tasten (`F2`, `Entf`) laufen über dieselben Einträge (`offers`), damit Maus und Tastatur nicht auseinanderlaufen.
- `canDropEntry(backend, root, rows, source, target)`: Ein Ziel ist die Wurzel oder eine sichtbare Ordnerzeile; nicht der Eintrag selbst, kein Pfad darunter, nicht der Ordner, in dem er liegt; ein geschützter Eintrag zieht nicht. Die Ziel-ID ist `explorer:<pfad>`, der Payload-Typ `explorer-entry`.
- `renameTarget(oldName, input)`: der getrimmte neue Name oder nichts (leer, unverändert).
- `deleteConfirmation(name, folder, count?)`: Titel, Text und Knopf des Dialogs. Die Anzahl kommt aus einem `files.list` des Ordners; scheitert es, nennt der Text keine Zahl.
- `actionErrorText(action, name, code)` und `skippedText(n)`.
- `afterRename`, `afterMove`, `afterDelete`, `afterFailure`: der Baum nach einer Aktion und die Ladungen, die laufen sollen (`replaceEntry`, `reloadFolder`, `expand`). Nach Umbenennen und Verschieben ist der neue Pfad gewählt; ein Zielordner, der zu war, klappt auf, damit die Auswahl sichtbar ist.

### Quotierung in `path-quote.ts`

`quotePath(path, shell)` mit `shell` aus `pasteShell(session)`: WSL `posix` (`'…'`, `'` → `'\''`), Windows `pwsh` und `powershell` (`'…'`, `'` → `''`; PowerShell behandelt auch die typografischen Apostrophe U+2018 bis U+201B als Anführungszeichen, sie werden ebenfalls verdoppelt), `cmd` (`"…"`; Windows-Namen enthalten kein `"`). Eine Windows-Session ohne `launch.shell` gilt als PowerShell (der Core wählt `pwsh` oder `powershell`). Ein Pfad mit Steuerzeichen ergibt nichts: Ein Zeilenumbruch im Namen wäre nach `Terminal.paste` (Zeilenumbruch → CR) ein Enter. Bekannte Grenze: `cmd` setzt `%NAME%` auch zwischen Anführungszeichen ein; ein Ordner mit `%` im Namen kann im eingefügten Text anders aussehen. Es gibt in der interaktiven `cmd` kein Escape dafür, das zwischen Anführungszeichen wirkt.

### Einfügen nur in den Schreiber

Das Panel folgt dem Pane aus `explorerPaneId`; schreibt es, ist es der Schreiber der Session des Panels in diesem Tab (sonst gäbe es im Tab keinen Schreiber, weil `explorerPaneId` einen bevorzugt). `App.tsx` gibt dem Panel `paste(text)` nur dann; es ruft `TerminalController.paste` (prüft die Rolle erneut), macht das Pane aktiv und gibt ihm den Fokus. Kein neuer Brückenaufruf.

### Dialog und Menü ausserhalb des Baums

Menü und Dialog hängen per Portal an `document.body`. React reicht Ereignisse eines Portals an seine React-Eltern weiter; der Escape-Handler des Panels prüft deshalb, ob das Ziel im DOM des Panels liegt, sonst schlösse Escape im Dialog das Panel statt des Dialogs.

### Umbenennen in der Zeile

Ein Feld ersetzt den Namen in der Zeile und hält alle Tasten bei sich (`stopPropagation`), damit weder der Baum noch der Fenster-Handler sie sieht. Verlassen des Felds bricht ab (wie Escape); bestätigt wird nur mit Enter. Während der Antwort ist das Feld gesperrt.

### Verworfen

- Natives HTML5-Ziehen: wie in ADR 0006 keine Abbruchtaste, mit `sendInputEvent` nicht prüfbar.
- OSC 52 für „Pfad kopieren“: Terminal-Ausgabe ist Daten, keine Anweisung; der Weg der App ist `navigator.clipboard`.

## Risks / Trade-offs

- Zwischen der Anzahl im Dialog und dem Löschen kann sich der Ordner ändern; gelöscht wird trotzdem rekursiv, was der Dialog sagt („endgültig, mit allem darin“).
- `isProtectedPath` gibt es zweimal; weicht die Fassung im Renderer ab, zeigt das Menü einen Eintrag, den der Dienst mit `EINVAL` ablehnt (Hinweis im Panel), nie umgekehrt einen Zugriff.
