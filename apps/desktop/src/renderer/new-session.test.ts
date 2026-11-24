import { describe, expect, it } from "vitest";
import { emptyNewSession, newSessionRequest, withBackend } from "./new-session.js";
import type { NewSessionForm } from "./new-session.js";

const form = (patch: Partial<NewSessionForm> = {}): NewSessionForm => ({ ...emptyNewSession(), ...patch });

describe("new session form (#65)", () => {
  it("starts as before: a WSL session named WSL in ~", () => {
    expect(emptyNewSession()).toEqual({ name: "WSL", backend: "wsl", shell: "", cwd: "~" });
    expect(newSessionRequest(form())).toEqual({
      ok: true,
      name: "WSL",
      launch: { backend: "wsl", cwd: "~" },
    });
  });

  it("[V1-15] builds a Windows launch spec with the chosen shell and directory", () => {
    const windows = withBackend(form(), "windows");
    expect(windows).toEqual({ name: "Windows", backend: "windows", shell: "", cwd: "~" });
    expect(newSessionRequest({ ...windows, shell: "pwsh", cwd: " C:\\dev " })).toEqual({
      ok: true,
      name: "Windows",
      launch: { backend: "windows", cwd: "C:\\dev", shell: "pwsh" },
    });
    // Without a choice the core takes the default shell of the settings (or pwsh, else powershell).
    expect(newSessionRequest(windows)).toEqual({
      ok: true,
      name: "Windows",
      launch: { backend: "windows", cwd: "~" },
    });
  });

  it("keeps a typed name and a directory that fits, resets one that does not", () => {
    const typed = withBackend(form({ name: "Build", cwd: "/srv/app" }), "windows");
    expect(typed.name).toBe("Build");
    expect(typed.cwd).toBe("~");
    expect(withBackend(form({ cwd: "~/src" }), "windows").cwd).toBe("~/src");
    expect(withBackend(form({ backend: "windows", name: "Windows", cwd: "C:\\x" }), "wsl")).toMatchObject({
      name: "WSL",
      cwd: "~",
    });
    const same = form();
    expect(withBackend(same, "wsl")).toBe(same);
  });

  it("refuses a Windows directory that is no Windows path, and an empty name", () => {
    expect(newSessionRequest(form({ backend: "windows", cwd: "/home/dev" }))).toEqual({
      ok: false,
      error: "Für Windows ein Pfad wie C:\\dev oder \\\\server\\freigabe",
    });
    expect(newSessionRequest(form({ name: "  " }))).toEqual({ ok: false, error: "Name fehlt" });
  });

  it("sends a WSL directory as typed and never a shell for WSL", () => {
    expect(newSessionRequest(form({ cwd: "", shell: "cmd" }))).toEqual({
      ok: true,
      name: "WSL",
      launch: { backend: "wsl", cwd: "~" },
    });
    expect(newSessionRequest(form({ cwd: "relative/dir" }))).toMatchObject({
      ok: true,
      launch: { backend: "wsl", cwd: "relative/dir" },
    });
  });
});
