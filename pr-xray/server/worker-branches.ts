// bb keeps the branch of a removed worktree, so every PR worker would leave a
// branch in the user's repository. This deletes those branches once bb has
// removed the worktree. Fix threads aren't tracked: their branches hold real work.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const run = promisify(execFile);
const KEY = "workerBranches";

const trackedWorkerSchema = z.object({
  threadId: z.string(),
  repoPath: z.string(),
  branchName: z.string().nullable(),
});
type TrackedWorker = z.infer<typeof trackedWorkerSchema>;

async function loadTracked(bb: BbPluginApi): Promise<TrackedWorker[]> {
  const parsed = z.array(trackedWorkerSchema).safeParse(await bb.storage.kv.get(KEY));
  return parsed.success ? parsed.data : [];
}

export async function trackWorkerBranch(bb: BbPluginApi, threadId: string, repoPath: string) {
  const tracked = await loadTracked(bb);
  tracked.push({ threadId, repoPath, branchName: null });
  await bb.storage.kv.set(KEY, tracked);
}

/** bb ends the branch names it generates with the thread id. Anything else isn't this worker's to delete. */
export function isWorkerBranch(branchName: string, threadId: string): boolean {
  return branchName.endsWith(`-${threadId}`);
}

async function deleteLocalBranch(repoPath: string, branchName: string) {
  await run("git", ["-C", repoPath, "branch", "-D", "--", branchName]);
}

/** Returns true when the worker needs no more tracking. Records the branch name while bb still reports it. */
async function settleWorker(
  bb: BbPluginApi,
  worker: TrackedWorker,
  deleteBranch: typeof deleteLocalBranch,
): Promise<boolean> {
  const thread = await bb.sdk.threads.get({ threadId: worker.threadId }).catch(() => null);
  if (thread !== null && thread.environmentId === null) return thread.archivedAt !== null;

  const environment =
    thread?.environmentId == null
      ? null
      : await bb.sdk.environments.get({ environmentId: thread.environmentId }).catch(() => null);
  if (environment !== null && environment.status !== "destroyed") {
    worker.branchName = environment.branchName ?? worker.branchName;
    return false;
  }

  if (worker.branchName !== null && isWorkerBranch(worker.branchName, worker.threadId)) {
    try {
      await deleteBranch(worker.repoPath, worker.branchName);
    } catch (error) {
      bb.log.warn(`delete branch ${worker.branchName}: ${String(error)}`);
    }
  }
  return true;
}

export async function sweepWorkerBranches(bb: BbPluginApi, deleteBranch = deleteLocalBranch) {
  const tracked = await loadTracked(bb);
  if (tracked.length === 0) return;

  const settled = new Set<string>();
  const branchNames = new Map<string, string | null>();
  for (const worker of tracked) {
    if (await settleWorker(bb, worker, deleteBranch)) settled.add(worker.threadId);
    branchNames.set(worker.threadId, worker.branchName);
  }

  // Re-read so a worker tracked during the sweep isn't lost.
  const remaining: TrackedWorker[] = [];
  for (const worker of await loadTracked(bb)) {
    if (settled.has(worker.threadId)) continue;
    remaining.push({ ...worker, branchName: branchNames.get(worker.threadId) ?? worker.branchName });
  }
  await bb.storage.kv.set(KEY, remaining);
}
