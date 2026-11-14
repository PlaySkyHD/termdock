// Working directory of a new session that names none (spec workspaces). Pure: no settings repository, no file system.
import type { Project, Settings, Workspace } from "@termdock/protocol";

export interface DefaultCwdInput {
  project?: Pick<Project, "path">;
  workspace?: Pick<Workspace, "defaultCwd">;
  settings?: Pick<Settings, "defaultCwd">;
}

/** Project path, then workspace `defaultCwd`, then setting `defaultCwd`, then `~`. */
export function defaultCwd(input: DefaultCwdInput = {}): string {
  return input.project?.path ?? input.workspace?.defaultCwd ?? input.settings?.defaultCwd ?? "~";
}
