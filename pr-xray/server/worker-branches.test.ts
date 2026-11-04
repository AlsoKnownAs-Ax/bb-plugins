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
const live = { environmentId: "env_1", archivedAt: null };

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

  it("deletes the branch of a worker that died before any sweep saw it", async () => {
    const bb = fakeBb(archived, [
      { status: "ready", branchName: BRANCH },
      { status: "destroyed", branchName: null },
    ]);
    const deleteBranch = vi.fn(async () => undefined);
    await trackWorkerBranch(bb, "thr_1", "/code/web");
    await sweepWorkerBranches(bb, deleteBranch);
    expect(deleteBranch).toHaveBeenCalledExactlyOnceWith("/code/web", BRANCH);
  });

  it("keeps tracking through a temporary failure", async () => {
    const bb = fakeBb(archived, [{ status: "ready", branchName: BRANCH }]);
    const deleteBranch = vi.fn(async () => undefined);
    await trackWorkerBranch(bb, "thr_1", "/code/web");
    vi.mocked(bb.sdk.threads.get).mockRejectedValueOnce(new Error("HTTP 503: daemon restarting"));
    await sweepWorkerBranches(bb, deleteBranch);
    expect(deleteBranch).not.toHaveBeenCalled();
    expect(await bb.storage.kv.get("workerBranches")).toHaveLength(1);
  });

  it("settles a worker whose thread is really gone", async () => {
    const bb = fakeBb(archived, [{ status: "ready", branchName: BRANCH }]);
    const deleteBranch = vi.fn(async () => undefined);
    await trackWorkerBranch(bb, "thr_1", "/code/web");
    vi.mocked(bb.sdk.threads.get).mockRejectedValueOnce(new Error("HTTP 404: Thread not found"));
    await sweepWorkerBranches(bb, deleteBranch);
    expect(deleteBranch).toHaveBeenCalledOnce();
    expect(await bb.storage.kv.get("workerBranches")).toEqual([]);
  });

  it("does not lose a worker tracked at the same time as another", async () => {
    const bb = fakeBb(live, []);
    await Promise.all([trackWorkerBranch(bb, "thr_1", "/a"), trackWorkerBranch(bb, "thr_2", "/b")]);
    expect(await bb.storage.kv.get("workerBranches")).toHaveLength(2);
  });

  it("makes no writes or environment calls for a live worker it already knows", async () => {
    const bb = fakeBb(live, [{ status: "ready", branchName: BRANCH }]);
    await trackWorkerBranch(bb, "thr_1", "/code/web");
    const set = vi.spyOn(bb.storage.kv, "set");
    const getEnvironment = vi.mocked(bb.sdk.environments.get);
    getEnvironment.mockClear();
    await sweepWorkerBranches(bb, vi.fn());
    expect(set).not.toHaveBeenCalled();
    expect(getEnvironment).not.toHaveBeenCalled();
  });

  it("never deletes a branch it can't tie to the worker", async () => {
    const bb = fakeBb(archived, [
      { status: "ready", branchName: "main" },
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
