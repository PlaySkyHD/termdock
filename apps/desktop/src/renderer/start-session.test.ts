import type { SessionCreateParams, SessionInfo, SessionState } from "@termdock/protocol";
import { describe, expect, it, vi } from "vitest";
import { pickOrCreateSession } from "./start-session.js";

function session(id: string, state: SessionState): SessionInfo {
  return {
    id,
    name: id,
    state,
    launch: { backend: "wsl", cwd: "~" },
    size: { cols: 80, rows: 24 },
    loggingEnabled: true,
    createdAt: "2026-11-13T00:00:00.000Z",
    updatedAt: "2026-11-13T00:00:00.000Z",
  };
}

describe("pickOrCreateSession", () => {
  it("creates a WSL session in ~ of the default distro when no session lives", async () => {
    const created = session("new", "Running");
    const api = {
      listSessions: vi.fn(async () => [session("old", "Exited"), session("gone", "Interrupted")]),
      createSession: vi.fn(async (_params: SessionCreateParams) => created),
    };

    const result = await pickOrCreateSession(api);

    expect(result).toBe(created);
    expect(api.createSession).toHaveBeenCalledWith({ name: "WSL", launch: { backend: "wsl", cwd: "~" } });
  });

  it("shows the first living session and creates none", async () => {
    const api = {
      listSessions: vi.fn(async () => [
        session("old", "Exited"),
        session("bg", "Detached"),
        session("fg", "Running"),
      ]),
      createSession: vi.fn(),
    };

    const result = await pickOrCreateSession(api);

    expect(result.id).toBe("bg");
    expect(api.createSession).not.toHaveBeenCalled();
  });
});
