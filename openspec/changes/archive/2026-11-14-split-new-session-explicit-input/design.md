# Design: Teilen startet neue Session, Eingabe-Übernahme nur ausdrücklich

## Context

Siehe proposal.md. Ursachen im Code (Stand `origin/main`):

- `App.tsx`: `commandDeps.split` und `TabBar.onSplit` rufen `split(direction, activeSessionId)`; `UiStore.splitPane` legt ein Pane mit derselben Session an, das als zweite View liest.
- `App.tsx`, `onPaneClick`: Ist die Rolle des Panes `reader`, ruft jeder echte Klick (`isClick` in `TerminalView.tsx`) `claimWriter`. Die neue Schreiber-View passt sofort die Größe an ihre Fläche an (`fitAsWriter`) und sendet `session.resize`; alle anderen Views folgen.
- `TerminalController.showWriterSize` bringt den Leser auf das Raster des Schreibers in normaler Schrift; `overflow: hidden` schneidet ab.

## Goals / Non-Goals

**Goals:** Teilen ergibt eine eigene Shell je Pane; Schreiber und Größe ändern sich nur auf ausdrücklichen Wunsch; ein Leser zeigt das ganze Raster, wenn es lesbar geht. Alles testbar ohne DOM.

**Non-Goals:** Protokolländerungen, aktuelles Verzeichnis der Shell, Variante B.

## Decisions

### Teilen als Befehl mit `createSession` (commands.ts)

`splitActivePane(deps, direction)` in `commands.ts` ersetzt `CommandDeps.split`: Es liest die Session des aktiven Panes, legt mit `deps.createSession` eine neue an (Name `<Name> 2`, `<Name> 3` … mit der kleinsten freien Nummer), meldet sie dem Store (`sessionCreated`) und teilt das Pane, das beim Drücken aktiv war. Kürzel und Teilen-Knöpfe nutzen dieselbe Funktion. Übernommen werden `backend`, `distro`, `shell`, `cwd` und `workspaceId`; nicht `command` (Teilen soll eine Shell starten, kein zweites `vim`), nicht `env` und nicht `profileId` (ein Profil kann einen Befehl tragen). Ist der Tab voll, wird nichts angelegt. Ein zweites Teilen, während eines läuft, wird mit Hinweis ignoriert (Satz je Store), damit schnelles Drücken keine Session über das Limit anlegt. Ist das Pane nach dem Anlegen verschwunden oder der Tab voll, öffnet die Session in einem eigenen Tab, damit sie sichtbar bleibt. Ein Fehler steht in der Statusleiste. Verworfen: Platzhalter-Pane vor der Antwort (bräuchte eine `sessionId`, `LayoutPane.sessionId` ist Pflicht).

Die neue Session ist eine andere als die des geteilten Panes, also macht `splitPane` das neue Pane aktiv; seine einzige View schreibt und passt die Größe an seine Fläche an.

### Klick-Absicht als reine Funktion (pane-layout.ts)

`takesInput(role, down, up)` entscheidet beim Loslassen der linken Taste: nur ein Leser, nur beim zweiten Klick eines Doppelklicks (`detail === 2`), ohne Ziehen. Eine Auswahl zählt hier nicht, denn der Doppelklick markiert in xterm.js ein Wort. Der einfache Klick macht das Pane weiterhin über `onMouseDownCapture` aktiv und sonst nichts. `isClick` entfällt. Der Knopf „Eingabe übernehmen“ liegt im lesenden Pane (unten rechts beim Hinweis) und in der Statusleiste (für das aktive Pane).

### Zoom des Lesers (terminal-size.ts, terminal-controller.ts)

`readerFontSize({ grid, area, cell, normal, min })` ist rein: `cell` ist die Zellgröße bei normaler Schrift. Faktor `s = min(1, area.width / (grid.cols · cell.width), area.height / (grid.rows · cell.height))`, Ergebnis `max(min, floor(normal · s))`. Ganze Pixel, weil Bruchteile Box- und Liniengrafik verfälschen; abgerundet, damit Rundung der Zellen beim kleineren Font nicht über die Fläche hinausführt. Unter `min` (8 px bei normal 14 px) bleibt `min`, und der Rest wird wie bisher abgeschnitten.

Der Controller wendet den Zoom an, nicht React: `TerminalSurface` bekommt `setFontSize(size)` und `measure()` (Fläche des Elements ohne Scrollbalken, Zellgröße bei normaler Schrift). Der Leser berechnet die Schrift nach jedem `showWriterSize` (Rolle, `session.resized`) und nach `layoutChanged` (Trenner, Fenster), gebündelt wie beim Schreiber. Der Schreiber setzt in `fitAsWriter` zuerst die normale Schrift, dann misst das Fit-Addon; sonst würde ein Leser, der gerade übernimmt, sein Raster aus der kleinen Schrift berechnen. Die Zellgröße bei normaler Schrift misst `TerminalView` aus den Render-Abmessungen von xterm.js (geschützter interner Zugriff wie `_showCursor`), solange die normale Schrift gilt, und merkt sie sich; aus der kleinen Schrift wird nicht zurückgerechnet, damit Rundung keine Schwingung zwischen zwei Größen erzeugt. Ohne Messung (nicht gezeichnet) bleibt die Schrift. Weil gerenderte Zellen auf Gerätepixel gerundet werden und nicht genau mit der Schrift schrumpfen, prüft der Controller danach mit der Zellgröße der aktuellen Schrift (`measure().current`) und geht pixelweise kleiner, solange das Raster nicht passt, höchstens bis zur Mindestschrift.

Verworfen: CSS-`transform: scale` (unscharf, Maus- und Auswahlkoordinaten von xterm.js stimmen nicht mehr), Variante B (kleinstes Pane bestimmt die Größe, Nutzerentscheidung: verschenkt Platz beim Schreiber).

### Screenshot-Szenen

Dieselbe Session im zweiten Pane per Umschalt+Klick in der Sidebar; ein einfacher Klick ins lesende Pane ändert weder Schreiber noch tmux-Größe (geprüft), der Knopf „Eingabe übernehmen“ und danach ein Doppelklick (echte Mausereignisse, `clickCount: 2`) verschieben den Schreiber. Neue Aufnahmen: zwei verschiedene Sessions nach Teilen per Knopf, gezoomter Leser. Die Kürzel-Szene teilt per `Ctrl+Shift+D`/`E` in neue Sessions und erzeugt den Leser für das abgelehnte Einfügen per Umschalt+Klick.

## Risks / Trade-offs

- [Zellgröße über interne API] → geschützter Zugriff; ohne Wert bleibt die normale Schrift (alter Zustand: abschneiden).
- [Neue Session bleibt, wenn das Teilen danach scheitert] → sie öffnet in einem eigenen Tab und steht in der Sidebar.
- [Doppelklick markiert zugleich ein Wort] → gewollt harmlos; die Auswahl bleibt nur sichtbar.
