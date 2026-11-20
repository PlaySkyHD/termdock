## ADDED Requirements

### Requirement: WSL-Integrationstests mit eigenem tmux-Socket

Jede Datei der WSL-Integrationstests (`*.wsl.test.ts`) SHALL einen tmux-Socket `termdock-test-<pid>-<nonce>` für sich allein nutzen, beim Ende ihren Server beenden (`tmux -L <socket> kill-server`, nur für den eigenen Socket) und Server von Sockets beendeter Prozesse aufräumen. Der feste Socket `termdock-test` und der Socket `termdock` MUST unberührt bleiben. Ein Test in der CI MUST sicherstellen, dass keine `*.wsl.test.ts` den festen Namen `termdock-test` enthält.

#### Scenario: Parallele Läufe

- **GIVEN** zwei Worktrees führen die WSL-Integrationstests gleichzeitig aus
- **WHEN** der Test einer Datei seine `td-*`-Sessions aufräumt
- **THEN** beendet er nur Sessions auf seinem Socket, und kein Test des anderen Laufs verliert eine Session

#### Scenario: Aufräumen verwaister Server

- **GIVEN** Sockets `termdock-test-<pid>-<nonce>` eines beendeten und eines laufenden Prozesses sowie `termdock` und `termdock-test`
- **WHEN** ein Testlauf aufräumt
- **THEN** beendet er nur den Server auf dem Socket des beendeten Prozesses

#### Scenario: Fester Socketname

- **GIVEN** die Quellen der `*.wsl.test.ts` in `packages/` und `apps/`
- **WHEN** der Test auf den Namen `termdock-test` als Zeichenkette prüft
- **THEN** findet er keine Datei, die ihn enthält
