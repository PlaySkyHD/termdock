# Proposal

## Why

Mit #156 (PR #161) lässt sich eine `Interrupted`- oder `Exited`-Session neu starten, der Knopf „Neu starten“ steht aber nur im Platzhalter eines Panes ohne View. Endet die Session bei offener App (Prozess endet, WSL wird gestoppt), bleibt ihr Pane eine angehängte View mit der letzten Ausgabe, ohne Knopf (#164). Neu starten geht dann nur über das Kontextmenü der Sidebar, obwohl gerade der WSL-Stopp der typische Fall ist.

## What Changes

- Eine angehängte View einer Session in `Exited` oder `Interrupted` zeigt oben im Pane eine Leiste mit Zustand und Grund (Regel `canRestart`).
- Nur die schreibende View hat in der Leiste den Knopf „Neu starten“; er sendet wie der Platzhalter `restartSession` und ist gesperrt, solange der Aufruf läuft. Eine lesende View zeigt nur einen Hinweis und sendet weder Eingabe noch Resize.
- Nach dem Neustart verschwindet die Leiste; die View bleibt angehängt und empfängt den neuen Lauf (der Core behält Views und Schreiber, die Trennzeile markiert den Beginn).
- Eine Ablehnung (`backend_unavailable`, `invalid_state`, Zeitlimit) steht in der Leiste, der Knopf ist danach wieder wählbar. Die Meldung verschwindet, sobald die Session wieder lebt.
- Screenshot-Gruppe `restore`: Szenen `19c` (Leiste mit Knopf in der angehängten View) und `19d` (dieselbe View nach dem Neustart, ohne Leiste), beide mit Sichtbarkeitsselektor.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: neu „Neustart in einer angehängten View“ und „Screenshot-Szenen für den Neustart in der View“ (ADDED).

## Impact

- Code: nur `apps/desktop` (Renderer `restart-session.ts`, `PaneTree.tsx`, `styles.css`; Szene in `main/screenshot-restore.ts`). Protokoll, Core und Bridge bleiben unverändert.
- ADR 0006: ein Satz zur Leiste in angehängten Views.
- Security: keine neuen Eingaben; der Knopf nutzt den bestehenden Bridge-Aufruf `restartSession` mit der Session-ID des Panes.
- Non-Goals: Neustart per Tastatur aus dem Terminal; ein Knopf in lesenden Views (sie übernehmen zuerst die Eingabe).
- Breaking Changes: keine.
