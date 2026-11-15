// Form checks of the settings dialog (#64, spec desktop-shell "Formularprüfung der Startprofile").
import { DEFAULT_SETTINGS } from "@termdock/protocol";
import type { LaunchProfile, Settings } from "@termdock/protocol";
import { describe, expect, it } from "vitest";
import {
  emptyProfileForm,
  formatArgumentList,
  formatEnv,
  formatMiB,
  generalForm,
  generalPatch,
  historyForm,
  historyPatch,
  parseArgumentList,
  parseEnv,
  pathProblem,
  profileChange,
  profileCreateParams,
  profileToForm,
  rebaseGeneral,
  rebaseHistory,
} from "./settings-form.js";
import type { ProfileForm } from "./settings-form.js";

const form = (change: Partial<ProfileForm> = {}): ProfileForm => ({
  ...emptyProfileForm(true),
  name: "Claude",
  cwd: "/srv/app",
  ...change,
});

describe("command as argument list", () => {
  it("takes one argument per line and never splits at spaces", () => {
    expect(parseArgumentList("claude\n--continue")).toEqual(["claude", "--continue"]);
    expect(parseArgumentList("git log --oneline")).toEqual(["git log --oneline"]);
    expect(parseArgumentList("echo\r\n'a; b' $HOME\r\n")).toEqual(["echo", "'a; b' $HOME"]);
  });

  it("drops empty lines; no text means the login shell", () => {
    expect(parseArgumentList("\n  \nhtop\n\n")).toEqual(["htop"]);
    expect(parseArgumentList("")).toEqual([]);
    expect(formatArgumentList(["claude", "--continue"])).toBe("claude\n--continue");
    expect(formatArgumentList(undefined)).toBe("");
  });

  it("is an array in the profile, and missing for the login shell", () => {
    const withCommand = profileCreateParams(form({ command: "claude\n--continue" }));
    expect(withCommand.ok && withCommand.params.launch.command).toEqual(["claude", "--continue"]);
    const shell = profileCreateParams(form({ command: "  \n" }));
    expect(shell.ok && "command" in shell.params.launch).toBe(false);
  });
});

describe("profile name", () => {
  it("rejects an empty or only-space name and one over 128 characters", () => {
    for (const name of ["", "   ", "n".repeat(129)]) {
      const result = profileCreateParams(form({ name }));
      expect(result.ok, JSON.stringify(name)).toBe(false);
      if (!result.ok) expect(result.errors.name).toBeDefined();
    }
  });

  it("sends the trimmed name", () => {
    const result = profileCreateParams(form({ name: "  Claude  " }));
    expect(result.ok && result.params.name).toBe("Claude");
  });
});

describe("paths", () => {
  it("wants an absolute Linux path for WSL and a drive or UNC path for Windows", () => {
    expect(pathProblem("/srv/app", "wsl")).toBeUndefined();
    expect(pathProblem("srv/app", "wsl")).toBeDefined();
    expect(pathProblem("C:\\dev", "wsl")).toBeDefined();
    expect(pathProblem("C:\\dev", "windows")).toBeUndefined();
    expect(pathProblem("D:/dev", "windows")).toBeUndefined();
    expect(pathProblem("\\\\server\\share", "windows")).toBeUndefined();
    expect(pathProblem("/srv", "windows")).toBeDefined();
    expect(pathProblem("C:dev", "windows")).toBeDefined();
    expect(pathProblem(`/${"x".repeat(512)}`, "wsl")).toBeDefined();
    expect(pathProblem("/a\u0000b", "wsl")).toBeDefined();
  });

  it("takes an empty directory or ~ as the default directory of the profile", () => {
    for (const cwd of ["", "  ", "~"]) {
      const result = profileCreateParams(form({ cwd }));
      expect(result.ok && result.params.launch.cwd, JSON.stringify(cwd)).toBe("~");
    }
    const windows = profileCreateParams(form({ backend: "windows", cwd: "" }));
    expect(windows.ok && windows.params.launch.cwd).toBe("~");
  });

  it("reports an invalid directory at its field and builds nothing", () => {
    const result = profileCreateParams(form({ cwd: "srv/app" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors)).toEqual(["cwd"]);
    expect(profileCreateParams(form({ backend: "windows", cwd: "/srv" })).ok).toBe(false);
  });
});

describe("environment", () => {
  it("reads NAME=value lines; the value may hold = and spaces", () => {
    expect(parseEnv("LANG=de_DE.UTF-8\nOPTS=a=b c\n\n")).toEqual({
      env: { LANG: "de_DE.UTF-8", OPTS: "a=b c" },
    });
    expect(parseEnv("")).toEqual({ env: {} });
    expect(formatEnv({ A: "1", B: "x=y" })).toBe("A=1\nB=x=y");
  });

  it("rejects invalid and repeated names", () => {
    for (const text of ["1A=x", "A-B=x", "=x", "NOEQUALS", "A=1\nA=2"]) {
      expect("error" in parseEnv(text), text).toBe(true);
    }
    const result = profileCreateParams(form({ env: "A-B=x" }));
    expect(!result.ok && result.errors.env).toBeDefined();
  });

  it("sends no env for an empty field", () => {
    const result = profileCreateParams(form({ env: "" }));
    expect(result.ok && "env" in result.params.launch).toBe(false);
  });
});

describe("launch spec of the profile", () => {
  it("names a distro only for WSL and a shell only for Windows", () => {
    const wsl = profileCreateParams(form({ distro: "Debian", shell: "cmd" }));
    expect(wsl.ok && wsl.params.launch).toEqual({ backend: "wsl", cwd: "/srv/app", distro: "Debian" });
    const windows = profileCreateParams(
      form({ backend: "windows", cwd: "C:\\dev", distro: "Debian", shell: "cmd" }),
    );
    expect(windows.ok && windows.params.launch).toEqual({ backend: "windows", cwd: "C:\\dev", shell: "cmd" });
    const fallback = profileCreateParams(form({ distro: " " }));
    expect(fallback.ok && "distro" in fallback.params.launch).toBe(false);
  });

  it("carries autostart and logging", () => {
    const result = profileCreateParams(form({ autostart: true, loggingEnabled: false }));
    expect(result.ok && [result.params.autostart, result.params.loggingEnabled]).toEqual([true, false]);
  });
});

describe("editing a profile", () => {
  const profile: LaunchProfile = {
    id: "p1",
    name: "Claude",
    workspaceId: "w1",
    projectId: "j1",
    launch: { backend: "wsl", cwd: "/srv/app", command: ["claude"], env: { LANG: "C" } },
    autostart: false,
    loggingEnabled: true,
  };

  it("shows the profile in the form and sends nothing when nothing changed", () => {
    const shown = profileToForm(profile);
    expect(shown).toMatchObject({ name: "Claude", cwd: "/srv/app", command: "claude", env: "LANG=C" });
    expect(profileChange(profile, shown)).toEqual({ ok: true, change: {} });
  });

  it("sends only what changed, the launch spec as a whole, never workspace or project", () => {
    const autostart = profileChange(profile, { ...profileToForm(profile), autostart: true });
    expect(autostart).toEqual({ ok: true, change: { autostart: true } });
    const command = profileChange(profile, { ...profileToForm(profile), command: "claude\n--continue" });
    expect(command).toEqual({
      ok: true,
      change: {
        launch: { backend: "wsl", cwd: "/srv/app", command: ["claude", "--continue"], env: { LANG: "C" } },
      },
    });
  });

  it("keeps command, env and directory it cannot show losslessly when their fields stay untouched (review)", () => {
    const odd: LaunchProfile = {
      ...profile,
      launch: {
        backend: "wsl",
        cwd: "~/work",
        command: ["bash", "-c", "echo a\necho b", ""],
        env: { MULTI: "a\nb" },
      },
    };
    const toggled = profileChange(odd, { ...profileToForm(odd), autostart: true });
    expect(toggled).toEqual({ ok: true, change: { autostart: true } });
    const renamed = profileChange(odd, { ...profileToForm(odd), name: "Neu" });
    expect(renamed).toEqual({ ok: true, change: { name: "Neu" } });
    // An edited directory is checked again.
    const moved = profileChange(odd, { ...profileToForm(odd), cwd: "work" });
    expect(!moved.ok && moved.errors.cwd).toBeDefined();
  });

  it("checks the edited form like a new one", () => {
    const result = profileChange(profile, { ...profileToForm(profile), name: " " });
    expect(!result.ok && result.errors.name).toBeDefined();
  });
});

describe("section Allgemein", () => {
  const stored: Settings = {
    ...DEFAULT_SETTINGS,
    defaultDistro: "Ubuntu",
    confirmQuitWhileRunning: false,
    quitAction: "keepSessions",
  };

  it("sends only the changed keys, and turning the question back on sends only that", () => {
    const shown = generalForm(stored);
    expect(shown).toEqual({ distro: "Ubuntu", shell: "", cwd: "", confirmQuit: false });
    expect(generalPatch(stored, shown)).toEqual({ ok: true, patch: {} });
    expect(generalPatch(stored, { ...shown, confirmQuit: true })).toEqual({
      ok: true,
      patch: { confirmQuitWhileRunning: true },
    });
  });

  it("removes a key whose field is emptied and sets new values", () => {
    expect(generalPatch(stored, { ...generalForm(stored), distro: "" })).toEqual({
      ok: true,
      patch: { defaultDistro: null },
    });
    expect(
      generalPatch(DEFAULT_SETTINGS, { distro: "Debian", shell: "pwsh", cwd: "/srv", confirmQuit: true }),
    ).toEqual({ ok: true, patch: { defaultDistro: "Debian", defaultShell: "pwsh", defaultCwd: "/srv" } });
  });

  it("wants a Linux or Windows path as default directory", () => {
    expect(generalPatch(DEFAULT_SETTINGS, { ...generalForm(DEFAULT_SETTINGS), cwd: "C:\\dev" }).ok).toBe(
      true,
    );
    const bad = generalPatch(DEFAULT_SETTINGS, { ...generalForm(DEFAULT_SETTINGS), cwd: "dev" });
    expect(!bad.ok && bad.errors.cwd).toBeDefined();
    const long = generalPatch(DEFAULT_SETTINGS, {
      ...generalForm(DEFAULT_SETTINGS),
      distro: "d".repeat(129),
    });
    expect(!long.ok && long.errors.distro).toBeDefined();
  });
});

describe("section Verlauf", () => {
  it("shows the limit in MiB and sends bytes", () => {
    expect(historyForm(DEFAULT_SETTINGS)).toEqual({ limitMiB: "10", enabledByDefault: true });
    expect(historyPatch(DEFAULT_SETTINGS, { limitMiB: "20", enabledByDefault: true })).toEqual({
      ok: true,
      patch: { historyLimitBytes: 20971520 },
    });
    expect(historyPatch(DEFAULT_SETTINGS, { limitMiB: "0,5", enabledByDefault: false })).toEqual({
      ok: true,
      patch: { historyLimitBytes: 524288, historyEnabledByDefault: false },
    });
    expect(formatMiB(65536)).toBe("0.0625");
  });

  it("sends no limit when its text is unchanged, even for an odd stored value (review)", () => {
    const odd = { ...DEFAULT_SETTINGS, historyLimitBytes: 100000 };
    expect(historyPatch(odd, historyForm(odd))).toEqual({ ok: true, patch: {} });
    expect(historyPatch(odd, { ...historyForm(odd), enabledByDefault: false })).toEqual({
      ok: true,
      patch: { historyEnabledByDefault: false },
    });
  });

  it("refuses a limit that is no number or outside 64 KiB to 1 GiB", () => {
    for (const limitMiB of ["0", "0.05", "1025", "2048", "zehn", "", "-1"]) {
      const result = historyPatch(DEFAULT_SETTINGS, { limitMiB, enabledByDefault: true });
      expect(result.ok, limitMiB).toBe(false);
      if (!result.ok) expect(result.errors.limit).toBeDefined();
    }
    expect(historyPatch(DEFAULT_SETTINGS, { limitMiB: "1024", enabledByDefault: true }).ok).toBe(true);
    expect(historyPatch(DEFAULT_SETTINGS, { limitMiB: "0.0625", enabledByDefault: true }).ok).toBe(true);
  });
});

// PR #115 review: settings.changed while a section is open.
describe("rebasing an open form on new settings", () => {
  const old: Settings = { ...DEFAULT_SETTINGS, defaultDistro: "Ubuntu" };
  const fresh: Settings = {
    ...old,
    defaultDistro: "Debian",
    defaultCwd: "/srv",
    historyLimitBytes: 20971520,
  };

  it("takes the new value into untouched fields and keeps what the user typed", () => {
    const typed = { ...generalForm(old), shell: "cmd" as const };
    expect(rebaseGeneral(typed, old, fresh)).toEqual({
      distro: "Debian",
      shell: "cmd",
      cwd: "/srv",
      confirmQuit: true,
    });
    const own = { ...generalForm(old), distro: "Arch" };
    expect(rebaseGeneral(own, old, fresh).distro).toBe("Arch");
  });

  it("lets the user set back the old value against a change of another client", () => {
    // The form shows Debian after the event; choosing Ubuntu again must reach the core.
    const shown = rebaseGeneral(generalForm(old), old, fresh);
    expect(generalPatch(fresh, { ...shown, distro: "Ubuntu" })).toEqual({
      ok: true,
      patch: { defaultDistro: "Ubuntu" },
    });
  });

  it("does the same for the history section", () => {
    const typed = { ...historyForm(old), enabledByDefault: false };
    expect(rebaseHistory(typed, old, fresh)).toEqual({ limitMiB: "20", enabledByDefault: false });
    const own = { ...historyForm(old), limitMiB: "5" };
    expect(rebaseHistory(own, old, fresh).limitMiB).toBe("5");
  });
});
