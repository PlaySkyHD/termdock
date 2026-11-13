// Window content of Phase 2 start: one terminal view. Sidebar and tabs follow in #26.
import { useEffect, useState } from "react";
import type { SessionInfo } from "@termdock/protocol";
import type { TermdockApi } from "../shared/bridge.js";
import { pickOrCreateSession } from "./start-session.js";
import { TerminalView } from "./TerminalView.js";

export function App({ api }: { api: TermdockApi }) {
  const [session, setSession] = useState<SessionInfo>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    pickOrCreateSession(api).then(
      (picked) => !cancelled && setSession(picked),
      (failure: unknown) =>
        !cancelled && setError(failure instanceof Error ? failure.message : String(failure)),
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (error) return <div className="app-message app-message--error">Session nicht verfügbar: {error}</div>;
  if (!session) return <div className="app-message">Verbinde mit dem Core …</div>;
  return <TerminalView api={api} session={session} />;
}
