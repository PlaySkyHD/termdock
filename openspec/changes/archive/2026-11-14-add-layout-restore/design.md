# Design

## Context

Der Core speichert ein globales Layout mit Revision (#25). ADR 0006 legt fest: ein Main-Prozess besitzt alle Fenster, der Store je Fenster liegt im Renderer in der Form `LayoutWindow`/`LayoutTab`. Position und Größe kennt nur der Main (`BrowserWindow`). Seit #26 öffnet die App keine Session automatisch.

## Goals / Non-Goals

**Goals:** Fenster, Tabs, Splits, aktive Panes und Sidebar nach einem Neustart der Oberfläche wiederherstellen; Platzhalter statt `Running` für nicht lebende Sessions; Revisionskonflikte lösen.

**Non-Goals:** Protokoll und Core ändern, beendete Sessions neu starten (Phase 3), Sidebar-Breite, Tastenkürzel.

## Decisions

- **Aufteilung: Fenster melden, Main bündelt.** Der Renderer meldet nach jeder Änderung seines `LayoutWindow` (ohne `id`, `bounds`, `maximized`) über `reportLayout`; der Main hält je Fenster Teil und Geometrie im `LayoutCoordinator` und baut daraus das Dokument. Alternative: jedes Fenster speichert sein Dokument selbst; verworfen, weil das Layout global ist (ein Dokument, eine Revision), die Fenster sich gegenseitig überschrieben und die Geometrie dem Renderer gehören müsste. Der Main prüft jede Meldung, indem er das Gesamtdokument mit `validateLayoutDocument` aus `@termdock/protocol` prüft (Grenzen, eindeutige IDs über Fenster hinweg); eine Meldung, die es verletzt, wird mit `bad_request` abgelehnt und ändert nichts.
- **Fenster-ID gehört dem Main.** `windowLayout` liefert dem Renderer beim Start (und nach einem Neuladen der Seite) das `LayoutWindow` seines Fensters mit der ID aus dem Dokument; der Renderer meldet erst danach, sonst überschriebe der leere Startzustand das Gespeicherte. Bis dahin zeigt die Seite nichts.
- **Speichern gebündelt.** Änderungen setzen ein Dirty-Flag und starten einen Timer von 400 ms (Entprellung, höchstens 2 s nach der ersten Änderung, damit Ziehen eines Trenners nicht aushungert). Es läuft höchstens ein `layout.save`; Änderungen während des Speicherns führen zu einem weiteren Durchlauf. `flush()` speichert sofort und wartet; der Main ruft es beim Beenden mit 3 s Obergrenze auf, bevor er die Verbindung schließt.
- **Revisionskonflikt.** `layout.save` mit `baseRevision`; bei `invalid_state` ruft der Coordinator `layout.get`, übernimmt nur die Revision und speichert den eigenen Stand erneut (höchstens 3 Versuche): der letzte Stand gewinnt, wie das Issue es verlangt. Andere Fehler (Timeout, getrennt) bleiben als Dirty-Flag stehen und werden beim nächsten Speichern oder Flush erneut versucht. Ist beim Start `layout.get` gescheitert, holt der erste Speichervorgang die Revision nach, statt blind zu überschreiben.
- **Beenden und Schließen.** Das letzte offene Fenster und alle Fenster beim Beenden bleiben im Dokument (sonst wäre es nach dem Beenden leer); ein weiteres Fenster, das der Benutzer schließt, wird entfernt. Position, Größe und Maximierung werden bei `move`, `resize`, `maximize`, `unmaximize` und beim Schließen gelesen (`getNormalBounds`, also die Größe vor dem Maximieren).
- **Geometrie gegen Bildschirme.** `fitBounds` (rein, `window-geometry.ts`) behält gespeicherte Bounds, wenn mindestens 200×100 Pixel in der Arbeitsfläche eines Bildschirms liegen; sonst wird das Fenster auf dem primären Bildschirm zentriert, auf dessen Arbeitsfläche begrenzt (mindestens 400×300). Mehr als 16 Fenster öffnet der Main nicht (Grenze des Dokuments).
- **Abbildung.** `src/shared/layout-mapping.ts` (rein) wandelt Fenster in `LayoutDocument` und zurück, trennt den Teil, den der Renderer meldet, von `id`/Geometrie und stellt aus einem Dokument die Fenster her (aktiver Tab und Pane werden bei Bedarf auf vorhandene gesetzt). Der Store bekommt `loadWindow` und das Flag `sessionsLoaded`; `App.tsx` ändert nur wenig (Start der Synchronisation, Platzhalter-Aktion).
- **Platzhalter.** `paneContent` (rein) entscheidet je Pane: Terminal (`Running`, `Detached`), „lädt“ (Sessions noch nicht geladen) oder Platzhalter mit Zustand, Exit-Code und „Pane schließen“ (`Starting`, `Exited`, `Interrupted`, `Archived`, fehlende Session). Eine fehlende Session wird erst nach der ersten Session-Liste als fehlend erkannt. Ein einmal angehängtes Pane behält seine Ausgabe, wenn die Session endet (unverändert).
- **Neustart der Oberfläche im Screenshot-Modus.** Der Main stellt `restartUi` bereit: Fenster ohne Entfernen aus dem Layout schließen, speichern, einen frischen Coordinator laden und die Fenster wie beim echten Start öffnen. Damit läuft der Produktionspfad, nur ohne den Prozess zu beenden.

## Risks / Trade-offs

- Eine Meldung, die kurz vor dem Schließen noch unterwegs ist, kann fehlen (Millisekunden). Akzeptiert.
- Schließt der Benutzer die letzten Fenster nacheinander, bleibt das zuletzt geschlossene im Layout; die früher geschlossenen sind weg. Das entspricht „Fenster schließen“ gegenüber „App beenden“.
- Mehrere laufende Apps teilen sich einen Main (Einzelinstanz), es gibt also nur einen Schreiber; Konflikte entstehen nur durch andere Clients.
