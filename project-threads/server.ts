// bb-plugin-project-threads — backend.
//
// Tracks which threads belong in the sidebar's "Working" section. A thread
// enters when it starts running, turns "ready" when it goes idle or fails,
// and leaves only when the user dismisses it (or archives/deletes it).
// Tracking lives on the server so a thread that finishes while no sidebar is
// open still shows up as Ready next time.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PROJECT_EMOJIS } from "./lib/project-emojis";
import {
  addProject,
  adoptProjects,
  assignPersonalThread,
  createWorkspace,
  deleteWorkspace,
  forgetPersonalThread,
  initialWorkspacesState,
  moveProject,
  removeProject,
  renameWorkspace,
  switchWorkspace,
  type WorkspacesState,
} from "./lib/workspaces";

const idSchema = z.string().min(1).max(200);
const workspaceNameSchema = z.string().trim().min(1).max(60);
const workspacesViewSchema = z.object({
  workspaces: z.array(
    z.object({ id: z.string(), name: z.string(), projectIds: z.array(z.string()) }),
  ),
  activeId: z.string(),
  personalThreadWorkspaceIds: z.record(z.string(), z.string()),
});
export type WorkspacesView = z.infer<typeof workspacesViewSchema>;

const workingEntrySchema = z.object({
  threadId: z.string(),
  phase: z.enum(["running", "ready"]),
  failed: z.boolean(),
  /** Epoch ms of the last phase change. */
  changedAt: z.number(),
});
export type WorkingEntry = z.infer<typeof workingEntrySchema>;

export const rpcContract = defineRpcContract({
  working_list: {
    input: z.null(),
    output: z.object({ entries: z.array(workingEntrySchema) }),
  },
  working_dismiss: {
    input: z.object({ threadId: z.string().min(1).max(200) }),
    output: z.object({ removed: z.boolean() }),
  },
  emojis_list: {
    input: z.null(),
    output: z.object({ emojis: z.record(z.string(), z.string()) }),
  },
  emojis_set: {
    input: z.object({
      projectId: z.string().min(1).max(200),
      /** null clears the project's emoji. */
      emoji: z.enum(PROJECT_EMOJIS).nullable(),
    }),
    output: z.object({ emojis: z.record(z.string(), z.string()) }),
  },
  workspaces_list: { input: z.null(), output: workspacesViewSchema },
  /** Places projects the plugin hasn't seen yet into the active workspace. */
  workspaces_sync: {
    input: z.object({
      projectIds: z.array(idSchema).max(5000),
      personalProjectId: idSchema.nullable(),
    }),
    output: workspacesViewSchema,
  },
  workspace_create: {
    input: z.object({ name: workspaceNameSchema }),
    output: workspacesViewSchema,
  },
  workspace_rename: {
    input: z.object({ workspaceId: idSchema, name: workspaceNameSchema }),
    output: workspacesViewSchema,
  },
  workspace_delete: {
    input: z.object({ workspaceId: idSchema }),
    output: workspacesViewSchema,
  },
  workspace_switch: {
    input: z.object({ workspaceId: idSchema }),
    output: workspacesViewSchema,
  },
  workspace_set_project: {
    input: z.object({
      workspaceId: idSchema,
      projectId: idSchema,
      member: z.boolean(),
    }),
    output: workspacesViewSchema,
  },
  workspace_move_project: {
    input: z.object({
      workspaceId: idSchema,
      projectId: idSchema,
      direction: z.enum(["up", "down"]),
    }),
    output: workspacesViewSchema,
  },
});

/** Realtime channel the sidebar listens on. */
export const WORKING_CHANGED = "working-changed";
const KV_KEY = "working";
/** Realtime channel for project emoji changes. */
export const EMOJIS_CHANGED = "emojis-changed";
const EMOJIS_KV_KEY = "project-emojis";
/** Realtime channel for workspace changes. */
export const WORKSPACES_CHANGED = "workspaces-changed";
const WORKSPACES_KV_KEY = "workspaces";

type WorkingMap = Record<string, WorkingEntry>;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    maxThreadsPerProject: {
      type: "number",
      label: "Max threads per project",
      description:
        "Top-level threads shown under each project before a \"Show more\" link. 0 shows all.",
      default: 5,
      experimental_schema: z.number().int().min(0),
    },
    workspacesEnabled: {
      type: "boolean",
      label: "Enable workspaces",
      description:
        "Group projects into workspaces and show only the active workspace's projects. Switch from the Workspaces button in the sidebar footer.",
      default: false,
    },
  });

  // Serialize read-modify-write cycles so concurrent events don't clobber.
  let queue: Promise<unknown> = Promise.resolve();
  function mutate(fn: (map: WorkingMap) => boolean): Promise<boolean> {
    const run = queue.then(async () => {
      const map = (await bb.storage.kv.get<WorkingMap>(KV_KEY)) ?? {};
      const changed = fn(map);
      if (changed) {
        await bb.storage.kv.set(KV_KEY, map);
        bb.realtime.publish(WORKING_CHANGED, {});
      }
      return changed;
    });
    queue = run.catch(() => undefined);
    return run;
  }

  // Same queue as Working, so workspace edits can't overwrite each other.
  function mutateWorkspaces(
    fn: (state: WorkspacesState) => boolean,
  ): Promise<WorkspacesView> {
    const run = queue.then(async () => {
      const state =
        (await bb.storage.kv.get<WorkspacesState>(WORKSPACES_KV_KEY)) ??
        initialWorkspacesState();

      if (fn(state)) {
        await bb.storage.kv.set(WORKSPACES_KV_KEY, state);
        bb.realtime.publish(WORKSPACES_CHANGED, {});
      }

      return {
        workspaces: state.workspaces,
        activeId: state.activeId,
        personalThreadWorkspaceIds: state.personalThreadWorkspaceIds ?? {},
      };
    });
    queue = run.catch(() => undefined);
    return run;
  }

  function markRunning(threadId: string) {
    return mutate((map) => {
      if (map[threadId]?.phase === "running") return false;
      map[threadId] = {
        threadId,
        phase: "running",
        failed: false,
        changedAt: Date.now(),
      };
      return true;
    });
  }
  function markReady(threadId: string, failed: boolean) {
    return mutate((map) => {
      const entry = map[threadId];
      if (entry === undefined) return false;
      if (entry.phase === "ready" && entry.failed === failed) return false;
      map[threadId] = { ...entry, phase: "ready", failed, changedAt: Date.now() };
      return true;
    });
  }
  function remove(threadId: string) {
    return mutate((map) => {
      if (map[threadId] === undefined) return false;
      delete map[threadId];
      return true;
    });
  }

  bb.events.on("thread.active", ({ thread }) => {
    return markRunning(thread.id).then(() => undefined);
  });
  bb.events.on("thread.idle", ({ thread }) => {
    return markReady(thread.id, false).then(() => undefined);
  });
  bb.events.on("thread.failed", ({ thread }) => {
    return markReady(thread.id, true).then(() => undefined);
  });
  bb.events.on("thread.archived", ({ thread }) => {
    return remove(thread.id).then(() => undefined);
  });
  bb.events.on("thread.deleted", async ({ thread }) => {
    await remove(thread.id);
    await mutateWorkspaces((state) => forgetPersonalThread(state, thread.id));
  });
  bb.events.on("thread.created", async ({ thread }) => {
    const { workspacesEnabled } = await settings.get();

    await mutateWorkspaces((state) => {
      const personalChanged =
        thread.projectId === state.personalProjectId &&
        assignPersonalThread(state, thread.id, thread.parentThreadId, workspacesEnabled);

      // Starting a thread yourself brings its project into the active workspace.
      // Child, hidden and plugin-made threads are agents' work, so they don't.
      if (
        !workspacesEnabled ||
        thread.parentThreadId !== null ||
        thread.visibility === "hidden" ||
        thread.originPluginId !== null
      ) {
        return personalChanged;
      }

      return addProject(state, state.activeId, thread.projectId) || personalChanged;
    });
  });

  // Events aren't replayed while the plugin is unloaded: reconcile once so
  // threads already running get tracked, and tracked ones that finished
  // meanwhile turn Ready.
  async function reconcile() {
    const busy = new Set(["starting", "active", "stopping"]);
    const live = new Map<string, string>();
    for (let offset = 0; ; offset += 200) {
      const page = await bb.sdk.threads.list({ limit: 200, offset });
      for (const thread of page) live.set(thread.id, thread.status);
      if (page.length < 200) break;
    }
    await mutate((map) => {
      let changed = false;
      for (const [id, status] of live) {
        const entry = map[id];
        if (busy.has(status) && entry?.phase !== "running") {
          map[id] = { threadId: id, phase: "running", failed: false, changedAt: Date.now() };
          changed = true;
        } else if (!busy.has(status) && entry?.phase === "running") {
          map[id] = { ...entry, phase: "ready", failed: status === "error", changedAt: Date.now() };
          changed = true;
        }
      }
      for (const id of Object.keys(map)) {
        if (!live.has(id)) {
          delete map[id]; // archived or deleted while unloaded
          changed = true;
        }
      }
      return changed;
    });
  }
  reconcile().catch((error) => bb.log.warn(`reconcile failed: ${String(error)}`));

  bb.rpc.register(rpcContract, {
    working_list: async () => {
      const map = (await bb.storage.kv.get<WorkingMap>(KV_KEY)) ?? {};
      return { entries: Object.values(map) };
    },
    working_dismiss: async ({ threadId }) => ({
      removed: await remove(threadId),
    }),
    emojis_list: async () => ({
      emojis: (await bb.storage.kv.get<Record<string, string>>(EMOJIS_KV_KEY)) ?? {},
    }),
    emojis_set: ({ projectId, emoji }) => {
      // Same queue as Working, so two quick picks can't overwrite each other.
      const run = queue.then(async () => {
        const emojis =
          (await bb.storage.kv.get<Record<string, string>>(EMOJIS_KV_KEY)) ?? {};
        if (emoji === null) delete emojis[projectId];
        else emojis[projectId] = emoji;
        await bb.storage.kv.set(EMOJIS_KV_KEY, emojis);
        bb.realtime.publish(EMOJIS_CHANGED, {});
        return { emojis };
      });
      queue = run.catch(() => undefined);
      return run;
    },
    workspaces_list: () => mutateWorkspaces(() => false),
    workspaces_sync: ({ projectIds, personalProjectId }) =>
      mutateWorkspaces((state) =>
        adoptProjects(state, projectIds, personalProjectId),
      ),
    workspace_create: ({ name }) =>
      mutateWorkspaces((state) =>
        createWorkspace(state, crypto.randomUUID(), name),
      ),
    workspace_rename: ({ workspaceId, name }) =>
      mutateWorkspaces((state) => renameWorkspace(state, workspaceId, name)),
    workspace_delete: ({ workspaceId }) =>
      mutateWorkspaces((state) => deleteWorkspace(state, workspaceId)),
    workspace_switch: ({ workspaceId }) =>
      mutateWorkspaces((state) => switchWorkspace(state, workspaceId)),
    workspace_set_project: ({ workspaceId, projectId, member }) =>
      mutateWorkspaces((state) => {
        if (member) {
          return addProject(state, workspaceId, projectId);
        }

        return removeProject(state, workspaceId, projectId);
      }),
    workspace_move_project: ({ workspaceId, projectId, direction }) =>
      mutateWorkspaces((state) =>
        moveProject(state, workspaceId, projectId, direction),
      ),
  });
}
