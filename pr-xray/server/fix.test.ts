import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import type { PrDetails, ReviewThread } from "../shared/schema";
import { fixDiffComments } from "./fix";
import { prWorktreeEnvironment } from "./worker-environment";

const pr = {
  ref: { owner: "acme", repo: "web", number: 7 },
  url: "https://github.com/acme/web/pull/7",
  title: "Feature",
  headRef: "feature",
  baseRef: "main",
  headInBaseRepo: true,
} as PrDetails;
const threads: ReviewThread[] = [];

function fakeBb(spawn: ReturnType<typeof vi.fn>) {
  const project = {
    id: "proj_web",
    name: "web",
    gitRemoteUrl: "https://github.com/acme/web.git",
    sources: [{ type: "local_path", hostId: "host_1", path: "/code/web", isDefault: true }],
  };
  return {
    log: { warn: vi.fn() },
    sdk: {
      projects: { list: vi.fn(async () => [project]) },
      threads: { spawn },
    },
  } as unknown as BbPluginApi;
}

describe("fix threads", () => {
  it("run in a worktree of the PR branch", async () => {
    const spawn = vi.fn(async () => ({ id: "thr_1" }));
    await expect(fixDiffComments(fakeBb(spawn), pr, threads, new Map())).resolves.toEqual({ threadId: "thr_1" });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: prWorktreeEnvironment("host_1", "feature"),
      }),
    );
  });

  it("report a worktree failure instead of falling back to the checkout", async () => {
    const spawn = vi.fn(async () => {
      throw new Error("no such branch");
    });
    await expect(fixDiffComments(fakeBb(spawn), pr, threads, new Map())).rejects.toThrow("no such branch");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("are refused for forks", async () => {
    const spawn = vi.fn();
    const forkPr = { ...pr, headInBaseRepo: false } as PrDetails;
    await expect(fixDiffComments(fakeBb(spawn), forkPr, threads, new Map())).rejects.toThrow("forks");
    expect(spawn).not.toHaveBeenCalled();
  });
});
