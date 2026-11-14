# Design

## Kontext

Der Verlauf besteht je Session aus zwei Segmentdateien mit Einträgen von höchstens 16 KiB Rohbytes (ADR 0004). Ein Eintrag kann mitten in einer Zeile oder einer Escape-Sequenz enden. `HistoryStore.read` hält Schreiber und Segmentwechsel zurück, solange ein Leser offen ist.

## Entscheidung

**Suche als Strom über Einträge.** `searchHistory(source, options)` liest je Session die Einträge von alt nach neu und füttert einen Zeilenleser: UTF-8-Dekoder mit Zustand (Mehrbyte-Zeichen über Eintragsgrenzen), `AnsiStripper` (Zustandsautomat für CSI, OSC, DCS, SOS, PM, APC, Zwei-Zeichen-Escapes und C1-Formen über Eintragsgrenzen; er verwirft nur Zeichen, andere Steuerzeichen außer Tabulator und Zeilenumbruch auch), dann Zeilenende bei `\r` oder `\n` (ein reines `\r` überschreibt im Terminal die Zeile; leere Zeilen zählen nicht). Der Zeitstempel eines Treffers ist der des Eintrags, in dem die Zeile endet.

**Suchtext ist Text.** Er wird für `RegExp` maskiert (Flag `i`), damit Positionen in der Originalzeile stimmen (kein `toLowerCase`, das Längen ändert). Ein Suchtext mit Zeilenumbruch findet nichts.

**Grenzen.** Ein ungeschlossener Escape-String oder CSI wird nach 4096 Zeichen wieder Text. Eine Zeile über 4096 Zeichen wird am Puffer geschnitten; die letzten `Suchtext - 1` Zeichen bleiben für einen Treffer über den Schnitt. Treffer sammelt ein Sammler, der höchstens `2 * limit` Kandidaten hält und die neuesten behält; mehr Treffer als `limit` setzen `truncated`. Der Zeilenausschnitt ist höchstens 512 Zeichen um den Treffer. Nach 5 s Laufzeit endet die Suche mit dem bisherigen Ergebnis und `truncated: true`. Die Dauer wird je Eintrag geprüft; der Lese-Lock ist je Session nur so lange offen wie deren Lesen.

**Quellen.** `storeSource(store)` schreibt vor dem Lesen die Warteschlange (`flush`), damit die neueste Ausgabe zählt, und listet Sessions aus `history/` (`HistoryStore.listSessions`). Der Core übergibt nur Sessions, die die Registry kennt (`isKnownSession`), sonst fände die Suche Verläufe, die kein Benutzer mehr sieht. Ohne `sessionIds` werden alle durchsucht. Eine Session, die während der Suche gelöscht wird, wartet `remove` ab (offene Leser) und liefert danach nichts.

**Ein Treffer je Zeile, neueste zuerst.** Mehrere Treffer in einer Zeile wären Wiederholung ohne Nutzen. Die Sortierung nach Zeitstempel zeigt zuerst, was zuletzt geschah; bei einem Abbruch nach Zeit fehlt womöglich Älteres.

**Desktop.** `HistorySearchModel` (rein, ohne DOM) hält Zustand, wartet 250 ms nach der letzten Eingabe, lässt nur die Antwort der neuesten Suche gelten und gruppiert Treffer nach Session (Namen aus der Session-Liste des Fensters, `Gelöschte Session` sonst). Der Dialog ist modal wie die Kürzel-Übersicht: solange er offen ist, wirkt nur sein Befehl, Escape schließt. Ein Klick ruft dasselbe `open(sessionId, "tab")` wie die Seitenleiste; Sessions, die nicht leben, zeigen den vorhandenen Platzhalter. Die Brücke reicht nur `query` und `limit` weiter, nie Session-IDs.

## Verworfene Alternativen

- **Index auf der Platte:** Zusätzlicher Zustand, der mit dem Ringpuffer rotieren und beim Löschen mit entfernt werden müsste; bei höchstens 10 MiB je Session reicht ein Durchlauf mit Zeitgrenze.
- **Suche im Renderer:** Der Verlauf liegt im Core; der Renderer sähe Rohbytes.
- **Treffer je Session begrenzen:** Eine Session mit vielen Treffern würde dann gleich viel zeigen wie eine mit wenigen; die globale Grenze mit den neuesten Treffern ist einfacher zu erklären.

## Grenzen

- Ein Treffer über einen Zeilenumbruch ist nicht möglich.
- Neuzeichnen, das tmux von selbst auslöst, steht im Verlauf (ADR 0004) und kann Zeilen doppelt liefern.
