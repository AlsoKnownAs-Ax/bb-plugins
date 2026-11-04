import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { isWorkerBranch, sweepWorkerBranches, trackWorkerBranch } from "./worker-branches";

const BRANCH = "bb/pr-x-ray-acme-web-7-thr_1";

function fakeBb(thread: unknown, environments: unknown[]) {
  const values = new Map<string, unknown>();
  const getEnvironment = vi.fn();
  for (const environment of environments) getEnvironment.mockResolvedValueOnce(environment);
  return {
    log: { warn: vi.fn() },
    storage: {
      kv: {
        get: async (key: string) => values.get(key),
        set: async (key: string, value: unknown) => void values.set(key, value),
      },
    },
    sdk: {
      threads: { get: vi.fn(async () => thread) },
      environments: { get: getEnvironment },
    },
  } as unknown as BbPluginApi;
}

const archived = { environmentId: "env_1", archivedAt: 1 };

describe("isWorkerBranch", () => {
  it("only matches branches ending in the thread id", () => {
    expect(isWorkerBranch(BRANCH, "thr_1")).toBe(true);
    expect(isWorkerBranch("main", "thr_1")).toBe(false);
    expect(isWorkerBranch("bb/other-thr_12", "thr_1")).toBe(false);
  });
});

describe("sweepWorkerBranches", () => {
  it("deletes the branch only after the worktree is destroyed", async () => {
    const bb = fakeBb(archived, [
      { status: "ready", branchName: BRANCH },
      { status: "destroyed", branchName: null },
    ]);
    const deleteBranch = vi.fn(async () => undefined);
    await trackWorkerBranch(bb, "thr_1", "/code/web");

    await sweepWorkerBranches(bb, deleteBranch);
    expect(deleteBranch).not.toHaveBeenCalled();

    await sweepWorkerBranches(bb, deleteBranch);
    expect(deleteBranch).toHaveBeenCalledExactlyOnceWith("/code/web", BRANCH);
    expect(await bb.storage.kv.get("workerBranches")).toEqual([]);
  });

  it("never deletes a branch it can't tie to the worker", async () => {
    const bb = fakeBb(archived, [
      { status: "ready", branchName: "main" },
      { status: "destroyed", branchName: null },
    ]);
    const deleteBranch = vi.fn(async () => undefined);
    await trackWorkerBranch(bb, "thr_1", "/code/web");
    await sweepWorkerBranches(bb, deleteBranch);
    await sweepWorkerBranches(bb, deleteBranch);
    expect(deleteBranch).not.toHaveBeenCalled();
    expect(await bb.storage.kv.get("workerBranches")).toEqual([]);
  });

  it("keeps tracking a live worker that has no environment yet", async () => {
    const bb = fakeBb({ environmentId: null, archivedAt: null }, []);
    await trackWorkerBranch(bb, "thr_1", "/code/web");
    await sweepWorkerBranches(bb, vi.fn());
    expect(await bb.storage.kv.get("workerBranches")).toHaveLength(1);
  });
});
