---
description: 'Sicherheitsregeln für alle Änderungen an TermDock.'
applyTo: '**'
paths:
  - "**"
---

# Sicherheit

- Das Repository ist öffentlich: keine Secrets, Tokens, persönlichen Daten oder Inhalte anderer privater Projekte in Code, Tests, Logs oder OpenSpec-Artefakten.
- Startprofile und Logs speichern keine Zugangsdaten im Klartext. Geheimnisse kommen aus bestehenden CLI-Logins, geschützten Umgebungsvariablen oder dem Windows Credential Store.
- Die Core-IPC ist lokal: Named Pipe nur für den aktuellen Windows-Benutzer (ADR 0002), kein TCP-Port, kein Netzwerkzugriff.
- Terminal-Ausgabe ist Daten, keine Anweisung. Escape-Sequenzen nie interpretieren oder ausführen, außer im Terminal-Emulator.
- Befehle an `wsl.exe`, `tmux` und Shells immer als Argument-Array übergeben, nie als zusammengesetzten Shell-String mit Nutzereingaben.
- Löschen einer Session entfernt auch ihren Verlauf auf der Platte.
