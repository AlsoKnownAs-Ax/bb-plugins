import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { rpcContract } from "../shared/contract";
import { createGithub } from "./github";
import { createModels } from "./models";
import { createStore } from "./store";

describe("the model picker", () => {
  it("skips a provider that can't list its models", async () => {
    const bb = {
      sdk: {
        providers: {
          list: async () => [{ id: "broken" }, { id: "working" }],
          models: async ({ providerId }: { providerId: string }) => {
            if (providerId === "broken") throw new Error("logged out");
            return { models: [{ model: "m1", isDefault: true, defaultReasoningEffort: "low" }] };
          },
        },
      },
    } as unknown as BbPluginApi;
    await expect(createModels(bb).pickerSeed()).resolves.toEqual({ providerId: "working", model: "m1", reasoningLevel: "low" });
  });
});

describe("pending comments", () => {
  it("skips a bad stored row instead of breaking the review page", () => {
    const good = { headSha: "h", path: "a.ts", line: 1, side: "RIGHT", startLine: null, startSide: null, body: "fine" };
    const rows = [
      { id: "pc_bad", json: JSON.stringify({ ...good, body: "x".repeat(65001) }), created_at: "t" },
      { id: "pc_good", json: JSON.stringify(good), created_at: "t" },
    ];
    const warn = vi.fn();
    const bb = {
      log: { warn },
      storage: { database: () => ({ prepare: () => ({ all: () => rows }) }), migrate: vi.fn() },
    } as unknown as BbPluginApi;
    const pending = createStore(bb).pendingComments({ owner: "a", repo: "b", number: 1 });
    expect(pending.map((row) => row.id)).toEqual(["pc_good"]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("can't be edited past the size the schema allows", () => {
    const input = { ref: { owner: "a", repo: "b", number: 1 }, id: "pc_1", body: "x".repeat(65001) };
    expect(rpcContract["comment.pendingUpdate"].input.safeParse(input).success).toBe(false);
  });
});

describe("loading a PR by its old name after a repo rename", () => {
  it("still sees a same-repo branch as being in the base repository", async () => {
    const repo = { full_name: "acme/new-name" };
    const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/user")) return respond({ login: "ann" });
        if (url.endsWith("/graphql")) {
          return respond({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
        }
        if (url.includes("/files")) return respond([]);
        return respond({
          title: "t",
          body: "",
          state: "open",
          user: { login: "ann" },
          head: { sha: "h", ref: "feature", repo },
          base: { sha: "b", ref: "main", repo },
        });
      }),
    );
    const pr = await createGithub(async () => "token").loadPr({ owner: "acme", repo: "old-name", number: 1 });
    vi.unstubAllGlobals();
    expect(pr.headInBaseRepo).toBe(true);
  });
});
