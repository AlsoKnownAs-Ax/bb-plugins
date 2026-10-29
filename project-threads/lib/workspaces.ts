// Workspace state for the sidebar: named groups of projects. A project can be
// in any number of workspaces, including none. Every function edits the state
// in place and returns whether anything changed, so callers know to persist.

export type Workspace = {
  id: string;
  name: string;
  /** In the user's order for this workspace. */
  projectIds: string[];
};

export type WorkspacesState = {
  workspaces: Workspace[];
  activeId: string;
  /** Projects already placed once, so a project removed everywhere stays out. */
  seenProjectIds: string[];
  personalProjectId?: string;
  /**
   * Thread id → workspace id for Personal threads, so each workspace has its
   * own Personal. Unlisted threads are in Default.
   * shortcut: lives in one kv value (256 KB, roughly 2,500 threads); move to
   * thread plugin metadata if Personal gets that busy.
   */
  personalThreadWorkspaceIds?: Record<string, string>;
};

export const DEFAULT_WORKSPACE_ID = "default";

export function initialWorkspacesState(): WorkspacesState {
  return {
    workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: "Default", projectIds: [] }],
    activeId: DEFAULT_WORKSPACE_ID,
    seenProjectIds: [],
  };
}

export function activeWorkspace(state: WorkspacesState): Workspace {
  return (
    state.workspaces.find((workspace) => workspace.id === state.activeId) ??
    state.workspaces[0]
  );
}

export function personalThreadWorkspaceId(
  personalThreadWorkspaceIds: Readonly<Record<string, string>> | undefined,
  threadId: string,
): string {
  return personalThreadWorkspaceIds?.[threadId] ?? DEFAULT_WORKSPACE_ID;
}

/**
 * Files a new Personal thread: a child goes where its parent is, a top-level
 * thread goes to the active workspace while workspaces are on, else Default.
 */
export function assignPersonalThread(
  state: WorkspacesState,
  threadId: string,
  parentThreadId: string | null,
  workspacesEnabled: boolean,
): boolean {
  const workspaceId = newPersonalThreadWorkspaceId(
    state,
    parentThreadId,
    workspacesEnabled,
  );

  if (workspaceId === DEFAULT_WORKSPACE_ID) {
    return false;
  }

  state.personalThreadWorkspaceIds = {
    ...state.personalThreadWorkspaceIds,
    [threadId]: workspaceId,
  };
  return true;
}

export function forgetPersonalThread(
  state: WorkspacesState,
  threadId: string,
): boolean {
  if (state.personalThreadWorkspaceIds?.[threadId] === undefined) {
    return false;
  }

  delete state.personalThreadWorkspaceIds[threadId];
  return true;
}

/** Puts projects never seen before into the active workspace, Personal first. */
export function adoptProjects(
  state: WorkspacesState,
  projectIds: readonly string[],
  personalProjectId: string | null,
): boolean {
  const seen = new Set(state.seenProjectIds);
  const unseen = projectIds.filter((id) => !seen.has(id));
  const personalChanged =
    personalProjectId !== null && state.personalProjectId !== personalProjectId;

  if (personalChanged) {
    state.personalProjectId = personalProjectId;
  }

  if (unseen.length === 0) {
    return personalChanged;
  }

  const active = activeWorkspace(state);
  unseen.forEach((id) => addProject(state, active.id, id));

  if (personalProjectId !== null && unseen.includes(personalProjectId)) {
    active.projectIds = [
      personalProjectId,
      ...active.projectIds.filter((id) => id !== personalProjectId),
    ];
  }

  return true;
}

/** Appends a project to the end of a workspace and marks it seen. */
export function addProject(
  state: WorkspacesState,
  workspaceId: string,
  projectId: string,
): boolean {
  const workspace = state.workspaces.find(({ id }) => id === workspaceId);
  const wasSeen = state.seenProjectIds.includes(projectId);

  if (!wasSeen) {
    state.seenProjectIds.push(projectId);
  }

  if (!workspace || workspace.projectIds.includes(projectId)) {
    return !wasSeen;
  }

  workspace.projectIds.push(projectId);
  return true;
}

export function removeProject(
  state: WorkspacesState,
  workspaceId: string,
  projectId: string,
): boolean {
  const workspace = state.workspaces.find(({ id }) => id === workspaceId);

  if (!workspace || !workspace.projectIds.includes(projectId)) {
    return false;
  }

  workspace.projectIds = workspace.projectIds.filter((id) => id !== projectId);
  return true;
}

/** Swaps a project with its neighbour in one workspace's order. */
export function moveProject(
  state: WorkspacesState,
  workspaceId: string,
  projectId: string,
  direction: "up" | "down",
): boolean {
  const workspace = state.workspaces.find(({ id }) => id === workspaceId);
  const ids = workspace?.projectIds ?? [];
  const from = ids.indexOf(projectId);
  const to = from + MOVE_OFFSET[direction];

  if (from === -1 || to < 0 || to >= ids.length) {
    return false;
  }

  [ids[from], ids[to]] = [ids[to], ids[from]];
  return true;
}

/** Adds a workspace holding only Personal, and switches to it. */
export function createWorkspace(
  state: WorkspacesState,
  id: string,
  name: string,
): boolean {
  const projectIds = [state.personalProjectId]
    .filter((projectId): projectId is string => projectId !== undefined);
  state.workspaces.push({ id, name, projectIds });
  state.activeId = id;
  return true;
}

export function renameWorkspace(
  state: WorkspacesState,
  id: string,
  name: string,
): boolean {
  const workspace = state.workspaces.find((candidate) => candidate.id === id);

  if (!workspace || workspace.name === name) {
    return false;
  }

  workspace.name = name;
  return true;
}

/**
 * Deletes any workspace but Default; deleting the active one switches to
 * Default. Its Personal threads keep pointing at it, so they show nowhere.
 */
export function deleteWorkspace(state: WorkspacesState, id: string): boolean {
  if (id === DEFAULT_WORKSPACE_ID) {
    return false;
  }

  if (!state.workspaces.some((workspace) => workspace.id === id)) {
    return false;
  }

  state.workspaces = state.workspaces.filter((workspace) => workspace.id !== id);

  if (state.activeId === id) {
    state.activeId = DEFAULT_WORKSPACE_ID;
  }

  return true;
}

export function switchWorkspace(state: WorkspacesState, id: string): boolean {
  if (state.activeId === id) {
    return false;
  }

  if (!state.workspaces.some((workspace) => workspace.id === id)) {
    return false;
  }

  state.activeId = id;
  return true;
}

function newPersonalThreadWorkspaceId(
  state: WorkspacesState,
  parentThreadId: string | null,
  workspacesEnabled: boolean,
): string {
  if (parentThreadId !== null) {
    return personalThreadWorkspaceId(state.personalThreadWorkspaceIds, parentThreadId);
  }

  if (!workspacesEnabled) {
    return DEFAULT_WORKSPACE_ID;
  }

  return state.activeId;
}

const MOVE_OFFSET = { up: -1, down: 1 } satisfies Record<"up" | "down", number>;
