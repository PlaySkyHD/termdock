; Additions to the NSIS installer of electron-builder (ADR 0007, `nsis.include` in electron-builder.json).

; Per user only, without admin rights: skip the page that offers an installation for all users.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Where the program goes, that the data folder stays and that a running core is ended: electron-builder's check
; for a running app also finds the detached core (`TermDock.exe` as Node, ADR 0001) and kills it without
; `core.shutdown`. Its WSL keepalive ends with it, so WSL usually stops the distro and its tmux sessions.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "TermDock installieren"
  !define MUI_WELCOMEPAGE_TEXT "TermDock wird nur für den aktuellen Benutzer installiert, ohne Adminrechte, nach %LOCALAPPDATA%\Programs\TermDock.$\r$\n$\r$\nSessions, Verlauf und Einstellungen liegen in %APPDATA%\TermDock. Eine Deinstallation lässt diesen Ordner stehen.$\r$\n$\r$\nLäuft TermDock noch, auch nur der Core im Hintergrund, beendet der Installer es. Laufende WSL-Sessions enden dabei in der Regel."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "TermDock deinstallieren"
  !define MUI_WELCOMEPAGE_TEXT "Das Programm wird entfernt.$\r$\n$\r$\nSessions, Verlauf und Einstellungen in %APPDATA%\TermDock bleiben erhalten. Wer sie nicht mehr braucht, löscht den Ordner selbst.$\r$\n$\r$\nLäuft TermDock noch, auch nur der Core im Hintergrund, wird es beendet. Laufende WSL-Sessions enden dabei in der Regel."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
