// bb keeps the branch of a removed worktree, so every PR worker would leave a
// branch in the user's repository. This deletes those branches once bb has
// removed the worktree. Fix threads aren't tracked: their branches hold real work.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { orNullIfGone } from "./sdk-errors";

const run = promisify(execFile);
const KEY = "workerBranches";
const GIT_TIMEOUT_MS = 30_000;

// The tracked list is one kv value, so every read-modify-write takes its turn here.
let turn: Promise<unknown> = Promise.resolve();
function inTurn<T>(task: () => Promise<T>): Promise<T> {
  const result = turn.then(task, task);
  turn = result.catch(() => undefined);
  return result;
}

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

/** The worker's branch, while bb still reports it. Null when it can't say yet: a later sweep tries again. */
async function currentBranch(bb: BbPluginApi, threadId: string): Promise<string | null> {
  try {
    const { environmentId } = await bb.sdk.threads.get({ threadId });
    if (environmentId === null) return null;
    return (await bb.sdk.environments.get({ environmentId })).branchName ?? null;
  } catch {
    return null;
  }
}

export async function trackWorkerBranch(bb: BbPluginApi, threadId: string, repoPath: string) {
  const branchName = await currentBranch(bb, threadId);
  await inTurn(async () => {
    const tracked = await loadTracked(bb);
    tracked.push({ threadId, repoPath, branchName });
    await bb.storage.kv.set(KEY, tracked);
  });
}

/** bb ends the branch names it generates with the thread id. Anything else isn't this worker's to delete. */
export function isWorkerBranch(branchName: string, threadId: string): boolean {
  return branchName.endsWith(`-${threadId}`);
}

async function deleteLocalBranch(repoPath: string, branchName: string) {
  await run("git", ["-C", repoPath, "branch", "-D", "--", branchName], { timeout: GIT_TIMEOUT_MS });
}

/** Returns true when the worker needs no more tracking. Records the branch name while bb still reports it. */
async function settleWorker(
  bb: BbPluginApi,
  worker: TrackedWorker,
  deleteBranch: typeof deleteLocalBranch,
): Promise<boolean> {
  const thread = await orNullIfGone(() => bb.sdk.threads.get({ threadId: worker.threadId }));
  if (thread !== null && thread.environmentId === null) return thread.archivedAt !== null;
  // A live worker keeps its worktree, so once its branch is known there is nothing to ask bb.
  if (thread !== null && thread.archivedAt === null && worker.branchName !== null) return false;

  const environmentId = thread?.environmentId ?? null;
  const environment = environmentId === null ? null : await orNullIfGone(() => bb.sdk.environments.get({ environmentId }));
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

export function sweepWorkerBranches(bb: BbPluginApi, deleteBranch = deleteLocalBranch): Promise<void> {
  return inTurn(async () => {
    const tracked = await loadTracked(bb);
    const before = JSON.stringify(tracked);
    const remaining: TrackedWorker[] = [];
    for (const worker of tracked) {
      try {
        if (!(await settleWorker(bb, worker, deleteBranch))) remaining.push(worker);
      } catch (error) {
        // A temporary failure says nothing about the worker: try again next sweep.
        bb.log.warn(`check worker ${worker.threadId}: ${String(error)}`);
        remaining.push(worker);
      }
    }
    if (JSON.stringify(remaining) !== before) await bb.storage.kv.set(KEY, remaining);
  });
}
