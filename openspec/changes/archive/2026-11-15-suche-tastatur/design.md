# Design

## Kontext

`HistorySearchModel` (`renderer/history-search.ts`) hält den Zustand des Suchdialogs; `SearchDialog.tsx` zeigt ihn. Treffer sind Buttons in Gruppen je Session. Der Fokus liegt beim Öffnen im Suchfeld, und `trapFocus` hält Tab dort.

## Entscheidungen

### Auswahl im Modell, Regeln als reine Funktionen

Das Ergebnis (`status: "done"`) trägt `selected`, den Index über alle Gruppen in Anzeigereihenfolge, -1 ohne Auswahl. Neue Ergebnisse setzen es auf -1. Reine Funktionen: `moveSelection(count, current, key)` und `hitAt(groups, index)`; `HistorySearchModel.move(key)` und `activate(text)` nutzen sie. So ist alles ohne DOM testbar.

### Kein Umlaufen

Die Auswahl bleibt am Ende stehen. Es gibt bis zu 100 Treffer; ein Umlaufen würde beim Halten der Taste unbemerkt vom Ende zum Anfang springen. Pos1/Ende erreichen die Enden direkt. Das Kontextmenü (#63) läuft um, weil es wenige Einträge hat.

### Pos1 und Ende gehören dem Textcursor, bis ein Treffer gewählt ist

Im Suchfeld bewegen Pos1/Ende sonst den Cursor, was beim Korrigieren des Suchtexts gebraucht wird. Das Modell nutzt sie erst, wenn ein Treffer gewählt ist (`move` liefert sonst `false`, die Taste bleibt unberührt). Pfeil runter und hoch haben im einzeiligen Feld keine eigene Wirkung und wählen immer; ohne Auswahl wählt Pfeil runter den ersten, Pfeil hoch den letzten Treffer.

### Veraltete Ergebnisse

Ändert sich der Suchtext, bleiben die alten Treffer bis zur Antwort sichtbar. Bis dahin (`stale`) wählen die Tasten nichts und Enter öffnet nichts, sondern startet die Suche sofort. Ein Enter öffnet so nie einen Treffer, der nicht zum sichtbaren Text passt.

### Fokus und Zugänglichkeit

Der Fokus bleibt im Suchfeld: `role="combobox"`, `aria-controls` auf die Liste, `aria-expanded` bei Treffern, `aria-activedescendant` auf den gewählten Treffer. Die Liste ist eine `listbox`, jede Session-Gruppe eine `group` (beschriftet durch ihren Titel), jeder Treffer ein `option` mit `aria-selected` und `tabIndex=-1`. Der gewählte Treffer bekommt die Klasse `search__hit--selected` (wie Hover) und `scrollIntoView({ block: "nearest" })`.

### Screenshot-Szene

Die Szene drückt mit `webContents.sendInputEvent` Pfeil runter bis zum ersten Treffer der zweiten Gruppe, prüft Fokus, `aria-activedescendant` und Gruppe, nimmt auf, drückt Enter und prüft den aktiven Tab. Weicht etwas ab, endet der Lauf mit Exit-Code 1.
