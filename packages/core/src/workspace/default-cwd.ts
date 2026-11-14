// Working directory of a new session that names none (spec workspaces). Pure: no settings repository, no file system.
import type { BackendKind, Project, Settings, Workspace } from "@termdock/protocol";
import { projectPathProblem } from "./paths.js";

export interface DefaultCwdInput {
  /** Backend of the new session; candidates whose syntax does not fit it are skipped. */
  backend: BackendKind;
  project?: Pick<Project, "path">;
  workspace?: Pick<Workspace, "defaultCwd">;
  settings?: Pick<Settings, "defaultCwd">;
}

/**
 * Project path, then workspace `defaultCwd`, then setting `defaultCwd`, each only if its syntax fits `backend`
 * (`projectPathProblem`: a Linux path for "wsl", a Windows path for "windows"); otherwise `~`.
 * The fallback `~` is the home directory for "wsl". For "windows" it is a placeholder until the Windows backend
 * (#65) defines its own; callers must not pass it to a Windows shell unchecked.
 */
export function defaultCwd(input: DefaultCwdInput): string {
  const candidates = [input.project?.path, input.workspace?.defaultCwd, input.settings?.defaultCwd];
  for (const candidate of candidates) {
    if (candidate !== undefined && projectPathProblem(candidate, input.backend) === undefined)
      return candidate;
  }
  return "~";
}
