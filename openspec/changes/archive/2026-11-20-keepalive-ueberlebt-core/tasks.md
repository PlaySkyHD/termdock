# Tasks

## 1. WSL-Backend

- [x] 1.1 Test und Umsetzung: `keepaliveArgs` als wartender tmux-Client und `endKeepalivesArgs` mit `pkill -x -f` (`backend/wsl/commands.test.ts`)
- [x] 1.2 Test und Umsetzung: `DistroKeepalive` mit Übernahme vor dem ersten Start je Distro und `dispose`, das laufende Keepalives laufen lässt (`backend/wsl/keepalive.test.ts`)
- [x] 1.3 Test und Umsetzung: `WslBackend` verdrahtet die Übernahme auf seinem Socket, `dispose` lässt die Keepalives laufen (`backend/wsl/backend.test.ts`)
- [x] 1.4 `spawnKeepalive` startet `detached` mit `unref()`; WSL-Integrationstest: Core-Kill, 30 s, Keepalive und Session leben, drei Neustarts ergeben genau einen Keepalive, `stopSessions` hinterlässt keinen (`keepalive.wsl.test.ts`)

## 2. Dokumentation

- [x] 2.1 ADR 0003 (Keepalive, Übernahme, Grenze ohne Core), ADR 0001 (Abbau) und ADR 0007 (Update) anpassen; geprüft durch `keepalive.wsl.test.ts` und `backend.test.ts`
