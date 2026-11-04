import { afterEach, describe, expect, it, vi } from "vitest";
import { createGithub } from "./github";

afterEach(() => vi.unstubAllGlobals());

describe("reading a review's comments", () => {
  it("reads every page, not only the first 100", async () => {
    const page = (size: number) => Array.from({ length: size }, (_, id) => ({ id }));
    const fetchPage = vi.fn(async (url: string) => {
      const body = url.endsWith("&page=1") ? page(100) : page(1);
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchPage);
    const github = createGithub(async () => "token");
    const comments = await github.reviewComments({ owner: "acme", repo: "web", number: 7 }, 42);
    expect(comments).toHaveLength(101);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});
