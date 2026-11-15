# Design

## Kontext

`session.create` kennt kein `projectId` (`SessionCreateParams`: `name`, `launch`, `workspaceId`, `profileId`). Eine Session weiß daher nicht, zu welchem Projekt sie gehört; die Sidebar kann sie nur über den Workspace gruppieren. Die Sidebar zeigt Projekte als Zeilen unter dem Workspace; Klick öffnete bisher das Menü.

## Entscheidungen

### Parameter einer Projekt-Session (`sidebar-model.ts`, rein)

`projectSessionParams(project)` liefert `{ name: project.name, workspaceId: project.workspaceId, launch: { backend, distro?, cwd: project.path } }`. `distro` steht nur im `launch`, wenn das Projekt eine hat (sonst gilt die konfigurierte Standard-Distro). `shell`, `command` und `env` fehlen: Es startet die Standard-Shell, wie die Taste `Ctrl+Shift+T`; Profile je Projekt sind #64. Die Funktion ist rein und wird ohne DOM getestet.

### Start in `commands.ts` (`startProjectSession`)

Wie `splitActivePane` (#66) liegt der Ablauf im Befehlsmodul und nimmt Abhängigkeiten als Schnittstelle: `store`, `createSession`, `open(sessionId, mode)` und `notify`. Er legt die Session an, meldet sie dem Store (`sessionCreated`, idempotent zum Ereignis des Main) und öffnet sie mit dem `OpenMode` des Klicks: `tab` zeigt sie im aktiven Tab wie eine neue Session (ein neuer Tab, weil die Session neu ist), `newTab` erzwingt einen Tab, `split` teilt das aktive Pane. Ein Fehler des Core geht als Text an `notify` (Statusleiste); kein Dialog, weil die Zeile kein Formular hat.

Doppelstart: Ein Doppelklick würde zwei Sessions anlegen. Pro Store läuft höchstens ein Projektstart; ein zweiter Klick, solange der erste unterwegs ist, meldet „Neue Session wird noch gestartet …“ (derselbe Text wie beim Teilen), und legt nichts an.

### Klick und Menü

Die Projektzeile ruft bei Klick (Enter auf dem Knopf löst ebenfalls `click` aus) die neue Sidebar-Aktion `startProjectSession(project, mode)` mit dem Modus aus den Modifikatoren (wie `SessionRow`). Das Menü kommt weiter über `contextmenu` (Rechtsklick, Menütaste, Umschalt+F10). `projectMenu()` gibt `start` zuerst zurück; „Neue Session hier“ ruft dieselbe Aktion mit Modus `tab`. Der Fokus geht nach dem Start an das Terminal der neuen Session (`refocus` des Fensters), bei einem Fehler zurück auf die Projektzeile.

## Alternativen

- `projectId` im Protokoll und Gruppierung unter dem Projekt: nötig für „Sessions unter dem Projekt“, aber ein Vertragswechsel in `packages/protocol` und `packages/core`; eigenes Issue.
- Klick öffnet weiter das Menü, Start nur per Eintrag: widerspricht dem Wunsch, dass ein Klick etwas Sichtbares tut.
