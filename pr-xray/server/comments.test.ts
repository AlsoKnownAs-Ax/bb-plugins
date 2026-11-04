import { describe, expect, it, vi } from "vitest";
import type { PendingComment } from "../shared/schema";
import { createComments, stripMarker, withMarker } from "./comments";

describe("comment tag markers", () => {
  it("adds a marker that strips back to the original body", () => {
    const marked = withMarker("Needs a test.", "missing-test");
    expect(marked).toBe("Needs a test.\n\n<!-- pr-xray: tag=missing-test -->");
    expect(stripMarker(marked)).toBe("Needs a test.");
  });

  it("replaces an existing marker instead of stacking them", () => {
    const retagged = withMarker(withMarker("Rename this.", "naming"), "design");
    expect(retagged).toBe("Rename this.\n\n<!-- pr-xray: tag=design -->");
  });

  it("leaves other text alone", () => {
    expect(stripMarker("A plain comment.")).toBe("A plain comment.");
    const quoted = "<!-- pr-xray: tag=bug --> is the format";
    expect(stripMarker(quoted)).toBe(quoted);
  });
});

describe("submitting a review", () => {
  const ref = { owner: "acme", repo: "web", number: 7 };
  const draft = (id: string): PendingComment => ({
    id,
    createdAt: "2026-11-04T00:00:00.000Z",
    path: "a.ts",
    line: 3,
    side: "RIGHT",
    startLine: null,
    startSide: null,
    body: `draft ${id}`,
  });
  const posted = { id: 1, body: "draft", html_url: "https://github.com/x", path: "a.ts", line: 3 };

  function setup(first: PendingComment[]) {
    const rows = { current: first };
    const store = {
      pendingComments: () => rows.current,
      removePendingComments: (ids: string[]) => {
        rows.current = rows.current.filter((row) => !ids.includes(row.id));
      },
      insertComment: vi.fn(),
    };
    const github = {
      headSha: vi.fn(async () => "head"),
      submitReview: vi.fn(async () => 42),
      reviewComments: vi.fn(async () => [posted]),
    };
    const bb = {
      realtime: { publish: vi.fn() },
      log: { warn: vi.fn() },
      agents: { registerTool: vi.fn() },
      events: { on: vi.fn() },
    };
    const comments = createComments({ bb, store, github, models: {} } as unknown as Parameters<typeof createComments>[0]);
    return { comments, rows, store, github };
  }

  it("records the posted comments and clears the drafts", async () => {
    const { comments, rows, store } = setup([draft("a")]);
    await expect(comments.submitReview(ref, "COMMENT", "")).resolves.toEqual({ posted: 1 });
    expect(rows.current).toEqual([]);
    expect(store.insertComment).toHaveBeenCalledTimes(1);
  });

  it("does not leave drafts to post again when reading the comments back fails", async () => {
    const { comments, rows, github } = setup([draft("a")]);
    github.reviewComments.mockRejectedValueOnce(new Error("GitHub is down"));
    await expect(comments.submitReview(ref, "COMMENT", "")).resolves.toEqual({ posted: 1 });
    expect(rows.current).toEqual([]);
  });

  it("keeps a draft added while the review was being posted", async () => {
    const { comments, rows, github } = setup([draft("a")]);
    github.submitReview.mockImplementationOnce(async () => {
      rows.current = [...rows.current, draft("b")];
      return 42;
    });
    await comments.submitReview(ref, "COMMENT", "");
    expect(rows.current.map((row) => row.id)).toEqual(["b"]);
  });

  it("keeps the drafts when GitHub rejects the review", async () => {
    const { comments, rows, github } = setup([draft("a")]);
    github.submitReview.mockRejectedValueOnce(new Error("422"));
    await expect(comments.submitReview(ref, "COMMENT", "")).rejects.toThrow("422");
    expect(rows.current.map((row) => row.id)).toEqual(["a"]);
  });
});
