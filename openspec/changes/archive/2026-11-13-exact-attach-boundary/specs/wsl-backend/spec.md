## ADDED Requirements

### Requirement: Neuzeichnen über refresh-client

`redraw` SHALL die tmux-Clients der Session mit `list-clients -t =td-<id> -F '#{client_tty}'` ermitteln und jeden mit `refresh-client -t <tty>` vollständig neu zeichnen lassen, beides ohne PTY und aus `~`. Ein Client-Name, der kein Gerätepfad unter `/dev/` aus Buchstaben, Ziffern, `/`, `_` und `-` ist, MUST verworfen werden. Scheitert ein Aufruf, MUST `redraw` mit einem Fehler enden.

#### Scenario: Neuzeichnen kommt durch die PTY

- **GIVEN** eine laufende Session, deren Bildschirm einen Marker zeigt
- **WHEN** `redraw` aufgerufen wird
- **THEN** gibt die PTY den ganzen Bildschirm samt Marker erneut aus

#### Scenario: Fremder Client-Name

- **GIVEN** `list-clients` meldet `/dev/pts/3` und `;kill-server`
- **WHEN** `redraw` aufgerufen wird
- **THEN** ruft das Backend `refresh-client` nur für `/dev/pts/3` auf
