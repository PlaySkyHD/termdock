// Rules for workspaces and projects (spec workspaces): merge a change into the stored workspace, validate the
// whole result, then store it. The server sends the events; this class only changes the repository.
import { randomUUID } from "node:crypto";
import { MAX_PROJECTS_PER_WORKSPACE, MAX_WORKSPACES, validateWorkspace } from "@termdock/protocol";
import type {
  Project,
  ProjectCreateParams,
  ProjectUpdateParams,
  Workspace,
  WorkspaceCreateParams,
  WorkspaceUpdateParams,
} from "@termdock/protocol";
import { CoreError } from "../session/errors.js";
import type { WorkspaceRepository } from "../storage/workspace-repository.js";
import { projectPathProblem } from "./paths.js";

export class WorkspaceService {
  constructor(private readonly repository: WorkspaceRepository) {}

  list(): Workspace[] {
    return this.repository.list();
  }

  createWorkspace(params: WorkspaceCreateParams): Workspace {
    if (this.repository.list().length >= MAX_WORKSPACES) {
      throw new CoreError("invalid_state", `At most ${MAX_WORKSPACES} workspaces are allowed`);
    }
    const workspace: Workspace = { id: randomUUID(), name: params.name, projects: [] };
    if (params.defaultCwd !== undefined) workspace.defaultCwd = params.defaultCwd;
    return this.store(workspace);
  }

  updateWorkspace(params: WorkspaceUpdateParams): Workspace {
    const merged = this.workspace(params.workspaceId);
    if (params.name !== undefined) merged.name = params.name;
    if (params.defaultCwd === null) delete merged.defaultCwd;
    else if (params.defaultCwd !== undefined) merged.defaultCwd = params.defaultCwd;
    return this.store(merged);
  }

  /** Throws `not_found` for an unknown workspace; the caller deletes after it has ungrouped the sessions. */
  assertWorkspace(workspaceId: string): void {
    this.workspace(workspaceId);
  }

  /** `alsoInTransaction` runs in the transaction of the removal (see `WorkspaceRepository.delete`). */
  deleteWorkspace(workspaceId: string, alsoInTransaction?: () => void): void {
    if (!this.repository.delete(workspaceId, alsoInTransaction)) throw notFound("workspace", workspaceId);
  }

  createProject(params: ProjectCreateParams): Project {
    const workspace = this.workspace(params.workspaceId);
    if (workspace.projects.length >= MAX_PROJECTS_PER_WORKSPACE) {
      throw new CoreError(
        "invalid_state",
        `At most ${MAX_PROJECTS_PER_WORKSPACE} projects per workspace are allowed`,
      );
    }
    const project: Project = {
      id: randomUUID(),
      workspaceId: workspace.id,
      name: params.name,
      path: params.path,
      backend: params.backend,
    };
    if (params.distro !== undefined) project.distro = params.distro;
    workspace.projects.push(checkPath(project));
    this.store(workspace);
    return project;
  }

  updateProject(params: ProjectUpdateParams): Project {
    const workspace = this.workspaceOfProject(params.projectId);
    const project = workspace.projects.find((candidate) => candidate.id === params.projectId)!;
    if (params.name !== undefined) project.name = params.name;
    if (params.path !== undefined) project.path = params.path;
    if (params.backend !== undefined) project.backend = params.backend;
    if (params.distro === null) delete project.distro;
    else if (params.distro !== undefined) project.distro = params.distro;
    checkPath(project);
    this.store(workspace);
    return project;
  }

  deleteProject(projectId: string): void {
    const workspace = this.workspaceOfProject(projectId);
    workspace.projects = workspace.projects.filter((project) => project.id !== projectId);
    this.store(workspace);
  }

  private workspace(workspaceId: string): Workspace {
    const found = this.repository.list().find((workspace) => workspace.id === workspaceId);
    if (!found) throw notFound("workspace", workspaceId);
    return found;
  }

  private workspaceOfProject(projectId: string): Workspace {
    const found = this.repository
      .list()
      .find((workspace) => workspace.projects.some((project) => project.id === projectId));
    if (!found) throw notFound("project", projectId);
    return found;
  }

  /** Validates the merged workspace, so no client ever receives a list it has to reject, and saves it. */
  private store(workspace: Workspace): Workspace {
    const checked = validateWorkspace(workspace);
    if (!checked.ok) throw new CoreError("bad_request", checked.error.message);
    this.repository.save(workspace);
    return workspace;
  }
}

function checkPath(project: Project): Project {
  const problem = projectPathProblem(project.path, project.backend);
  if (problem !== undefined) throw new CoreError("bad_request", problem);
  return project;
}

function notFound(kind: "workspace" | "project", id: string): CoreError {
  return new CoreError("not_found", `Unknown ${kind} ${id.length > 64 ? `${id.slice(0, 64)}...` : id}`);
}
