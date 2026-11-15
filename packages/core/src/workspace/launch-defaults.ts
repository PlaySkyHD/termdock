// Distro and shell of a new session from the settings (spec settings, issue #64). Pure: the caller reads the settings.
import type { LaunchSpec, Settings } from "@termdock/protocol";

/**
 * A WSL spec without `distro` takes `defaultDistro`, a Windows spec without `shell` takes `defaultShell`. A value the
 * spec names stays; without a setting the backend resolves the WSL default distro as before.
 */
export function launchDefaults(
  launch: LaunchSpec,
  settings: Pick<Settings, "defaultDistro" | "defaultShell">,
): LaunchSpec {
  if (launch.backend === "wsl" && launch.distro === undefined && settings.defaultDistro !== undefined) {
    return { ...launch, distro: settings.defaultDistro };
  }
  if (launch.backend === "windows" && launch.shell === undefined && settings.defaultShell !== undefined) {
    return { ...launch, shell: settings.defaultShell };
  }
  return launch;
}
