# Proposal

## Why

Im Suchdialog (#62, `Ctrl+Shift+F`) lassen sich Treffer nur mit der Maus öffnen. Der Nutzer will ohne Maus durch die Treffer gehen und einen davon öffnen (#103, manueller Test Welle 2).

## What Changes

- Pfeil runter und hoch im Suchfeld wählen den nächsten und vorigen Treffer, über Session-Gruppen hinweg; an den Enden bleibt die Auswahl stehen. Pos1 und Ende springen zum ersten und letzten Treffer, sobald ein Treffer gewählt ist.
- Der gewählte Treffer ist hervorgehoben und scrollt ins Bild.
- Enter öffnet den gewählten Treffer wie ein Klick. Ohne Auswahl, oder wenn sich der Suchtext seit dem Ergebnis geändert hat, startet Enter die Suche.
- Neue Ergebnisse setzen die Auswahl zurück. Escape schließt wie bisher.
- Der Fokus bleibt im Suchfeld (`combobox`, Trefferliste als `listbox` mit `aria-activedescendant`).
- Screenshot-Szene: Pfeiltasten und Enter mit echten Tastenereignissen.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: neue Anforderung zur Tastaturbedienung der Treffer; die Anforderung zur Screenshot-Szene der Verlaufssuche wird um die Tastatur ergänzt.

## Impact

Nur `apps/desktop` (Renderer: `SearchDialog.tsx`, `history-search.ts`, `styles.css`; Screenshot-Szene `screenshot-search.ts`). Protokoll, Core und Brücke bleiben unverändert.
