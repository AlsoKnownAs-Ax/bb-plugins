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
});

/** Realtime channel the sidebar listens on. */
export const WORKING_CHANGED = "working-changed";
const KV_KEY = "working";
/** Realtime channel for project emoji changes. */
export const EMOJIS_CHANGED = "emojis-changed";
const EMOJIS_KV_KEY = "project-emojis";

type WorkingMap = Record<string, WorkingEntry>;

export default async function plugin(bb: BbPluginApi) {
  bb.settings.define({
    maxThreadsPerProject: {
      type: "number",
      label: "Max threads per project",
      description:
        "Top-level threads shown under each project before a \"Show more\" link. 0 shows all.",
      default: 5,
      experimental_schema: z.number().int().min(0),
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
  bb.events.on("thread.deleted", ({ thread }) => {
    return remove(thread.id).then(() => undefined);
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
  });
}
