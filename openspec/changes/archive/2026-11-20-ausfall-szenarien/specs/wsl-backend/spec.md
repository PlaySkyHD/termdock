## ADDED Requirements

### Requirement: Ende des tmux-Servers

Endet der tmux-Server des Sockets (`kill-server`, Absturz), SHALL jede PTY des Backends ihr Ende ohne Exit-Code melden und `exists` `false` liefern. Danach MUST für diesen Socket kein `wsl.exe`-Prozess des Backends übrig bleiben: keine PTY und kein neu gestarteter Keepalive.

#### Scenario: tmux-Server endet

- **GIVEN** zwei laufende Sessions auf dem Socket eines Tests, je mit PTY, und ihr Keepalive
- **WHEN** `tmux -L <socket> kill-server` läuft
- **THEN** werden beide Sessions `Interrupted`, in WSL läuft kein Prozess mit `-L <socket>` mehr und unter Windows kein `wsl.exe` mit dem Socket in der Befehlszeile, auch nicht 3 s später
