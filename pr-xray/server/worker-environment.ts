// Where agents that read a pull request run. PR content is untrusted, so these
// workers never get the user's own checkout: they run in a disposable worktree
// of the PR branch, or with no repository at all.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PrDetails } from "../shared/schema";
import { findProject, personalProjectId, type ProjectMatch } from "./projects";
import { trackWorkerBranch } from "./worker-branches";

type SpawnInput = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];
type WorkerInput = Pick<SpawnInput, "title" | "visibility" | "permissionMode" | "pluginMetadata"> &
  Partial<Pick<SpawnInput, "providerId" | "model" | "reasoningLevel" | "serviceTier">> & { prompt: string };

export interface ProvisioningTiming {
  timeoutMs: number;
  pollMs: number;
}

const PROVISIONING_TIMING: ProvisioningTiming = { timeoutMs: 30_000, pollMs: 250 };

export interface PrWorktreeTarget {
  projectId: string;
  hostId: string;
}

/**
 * The project and host that can hold a worktree of the PR branch. A fork's
 * branch is not in the project's origin, and a branch with the same name there
 * would be different code, so fork PRs have no target.
 */
export function prWorktreeTarget(project: ProjectMatch | null, pr: PrDetails): PrWorktreeTarget | null {
  if (project === null || project.hostId === null || !pr.headInBaseRepo) return null;
  return { projectId: project.projectId, hostId: project.hostId };
}

/** Uses `origin/<branch>` because bb only fetches a remote ref first, and the branch may not be local yet. */
export function prWorktreeEnvironment(hostId: string, headRef: string) {
  return {
    type: "host",
    hostId,
    workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: `origin/${headRef}` } },
  } as const;
}

/**
 * spawn returns before the worktree exists, and a failed worktree only shows up
 * afterwards: the thread errors without ever getting an environment. Past the
 * timeout the worker counts as started, and any later failure is reported as one.
 */
async function provisioningFailed(bb: BbPluginApi, threadId: string, timing: ProvisioningTiming): Promise<boolean> {
  const deadline = Date.now() + timing.timeoutMs;
  while (Date.now() < deadline) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.status === "error") return thread.environmentId === null;
    if (thread.status === "active" || thread.status === "idle") return false;
    await new Promise((resolve) => setTimeout(resolve, timing.pollMs));
  }
  return false;
}

/**
 * Spawns a worker in a worktree of the PR branch, or in the personal project
 * with no repository when there is no target or the worktree cannot be created.
 * Archiving the thread makes bb remove its worktree.
 */
export async function spawnPrWorker(
  bb: BbPluginApi,
  pr: PrDetails,
  buildInput: (hasRepo: boolean) => WorkerInput,
  timing: ProvisioningTiming = PROVISIONING_TIMING,
) {
  const project = await findProject(bb, pr.ref);
  const target = prWorktreeTarget(project, pr);
  if (target !== null) {
    try {
      const thread = await bb.sdk.threads.spawn({
        ...buildInput(true),
        projectId: target.projectId,
        environment: prWorktreeEnvironment(target.hostId, pr.headRef),
      });
      if (!(await provisioningFailed(bb, thread.id, timing))) {
        if (project?.path) await trackWorkerBranch(bb, thread.id, project.path);
        return { thread, hasRepo: true };
      }
      bb.log.warn(`worktree on ${pr.headRef} failed, continuing without a repository`);
      await bb.sdk.threads.archive({ threadId: thread.id });
    } catch (error) {
      bb.log.warn(`worktree on ${pr.headRef} failed, continuing without a repository: ${String(error)}`);
    }
  }
  const thread = await bb.sdk.threads.spawn({
    ...buildInput(false),
    projectId: await personalProjectId(bb),
    environment: { type: "project-default" },
  });
  return { thread, hasRepo: false };
}
