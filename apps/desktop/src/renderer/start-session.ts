// Which session a new window shows (until the sidebar of #26 lets the user choose).
import type { SessionInfo } from "@termdock/protocol";
import type { TermdockApi } from "../shared/bridge.js";

const LIVING: ReadonlySet<SessionInfo["state"]> = new Set(["Running", "Detached"]);

/** The first `Running` or `Detached` session; without one a new WSL session in `~` of the default distro. */
export async function pickOrCreateSession(
  api: Pick<TermdockApi, "listSessions" | "createSession">,
): Promise<SessionInfo> {
  const living = (await api.listSessions()).find((session) => LIVING.has(session.state));
  return living ?? api.createSession({ name: "WSL", launch: { backend: "wsl", cwd: "~" } });
}
