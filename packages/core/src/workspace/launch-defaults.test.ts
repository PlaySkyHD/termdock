import { describe, expect, it } from "vitest";
import { launchDefaults } from "./launch-defaults.js";

describe("launchDefaults (spec settings, issue #64)", () => {
  it("gives a WSL spec without distro the default distro", () => {
    expect(
      launchDefaults({ backend: "wsl", cwd: "/" }, { defaultDistro: "Debian", defaultShell: "cmd" }),
    ).toEqual({
      backend: "wsl",
      cwd: "/",
      distro: "Debian",
    });
  });

  it("gives a Windows spec without shell the default shell", () => {
    expect(
      launchDefaults({ backend: "windows", cwd: "C:\\" }, { defaultDistro: "Debian", defaultShell: "cmd" }),
    ).toEqual({ backend: "windows", cwd: "C:\\", shell: "cmd" });
  });

  it("keeps what the spec names and leaves it alone without settings", () => {
    const wsl = { backend: "wsl" as const, cwd: "/", distro: "Ubuntu" };
    const windows = { backend: "windows" as const, cwd: "C:\\", shell: "pwsh" as const };
    expect(launchDefaults(wsl, { defaultDistro: "Debian" })).toEqual(wsl);
    expect(launchDefaults(windows, { defaultShell: "cmd" })).toEqual(windows);
    expect(launchDefaults({ backend: "wsl", cwd: "/" }, {})).toEqual({ backend: "wsl", cwd: "/" });
  });
});
