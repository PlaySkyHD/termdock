# Proposal

## Why

Screenshot-Läufe öffnen ihre Fenster auf dem Hauptmonitor und verdecken dort, woran der Nutzer gerade arbeitet oder was er schaut. Agents starten diese Läufe oft und parallel. Hat der Rechner mehrere Monitore, sollen die Fenster auf einem anderen erscheinen (Nutzerwunsch vom 19.11.2026).

## What Changes

- Im Screenshot-Modus öffnen neue Fenster ohne gespeicherte Position 40 px innerhalb des Arbeitsbereichs eines Nebenmonitors, standardmäßig des ersten Monitors, der nicht der Hauptmonitor ist. Gibt es keinen, bleibt es der Hauptmonitor.
- `TERMDOCK_SCREENSHOT_DISPLAY` wählt den Monitor: `primary` oder die 1-basierte Nummer in der Reihenfolge von `screen.getAllDisplays()`. Eine Nummer, die es nicht gibt, gilt wie ohne Angabe.
- Die Wiederherstellungs-Szene setzt ihre Fensterpositionen relativ zum ersten Fenster statt absolut auf den Hauptmonitor.
- `docs/agent-lessons-learned.md` nennt die Variable.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: neue Anforderung „Screenshot-Fenster auf einem Nebenmonitor“ (ADDED).

## Impact

- Nur `apps/desktop` (`window-geometry.ts`, `main.ts`, `screenshot-restore.ts`) und Doku. Kein Vertragswechsel, keine Dependency. Der normale App-Start ist nicht betroffen.
- Non-Goals: Fokus nicht stehlen (einige Szenen brauchen das fokussierte Fenster).
- Security: keine neue Angriffsfläche; die Variable wird nur als Zahl oder `primary` gelesen.
