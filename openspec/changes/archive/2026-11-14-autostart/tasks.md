# Tasks

## 1. Autostart-Modul

- [x] 1.1 Test und Umsetzung: zwei Autostart-Profile und ein normales ergeben genau zwei Sessions mit Name, Workspace, Verlauf-Schalter, `LaunchSpec` und Standardverzeichnis des Profils; `onCreated` meldet jede einmal (`autostart.test.ts`, `autostart.ts`)
- [x] 1.2 Test und Umsetzung: Profil mit lebender Session (`Detached`, `Starting`) bekommt keine neue, Profil mit `Interrupted`-, `Exited`- oder `Archived`-Session eine neue, die alte bleibt (`autostart.test.ts`)
- [x] 1.3 Test und Umsetzung: nicht erreichbares oder fehlendes Backend → keine Session, eine Prüfung und eine Meldung je Backend, `core.status`-Eintrag über `SessionRegistry.reportBackendUnavailable`; gescheiterter Start → `Interrupted`, eine Meldung, ein Start (`autostart.test.ts`, `registry.ts`)
- [x] 1.4 Test und Umsetzung: Abbruch während der Prüfung legt nichts an (`autostart.test.ts`)

## 2. Core-Start

- [x] 2.1 Test und Umsetzung: `runCore` führt den Autostart nach dem Reconcile aus, Anfragen warten bis zum Eintragen; zwei Clients sehen dieselbe Session, ein Start (`run-core.test.ts`, `run-core.ts`)
- [x] 2.2 Test: Core-Neustart mit laufenden Autostart-Sessions legt keine neue an; nach `Interrupted` genau eine neue (`run-core.test.ts`)
- [x] 2.3 Test: nicht erreichbares WSL meldet `backend_unavailable` einmal auf stderr und in `core.status` (`run-core.test.ts`)
- [x] 2.4 WSL-Integrationstest: Autostart-Profil startet eine tmux-Session; nach Core-Neustart keine zweite (`autostart.wsl.test.ts`)

## 3. Dokumentation

- [x] 3.1 ADR 0001 (Startreihenfolge) und ADR 0005 (Autostart) präzisieren
