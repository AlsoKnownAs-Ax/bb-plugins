import { describe, expect, it } from "vitest";
import type { ReviewGet } from "../shared/contract";
import type { Hunk, PendingComment, ReviewGroup } from "../shared/schema";
import { displayGroups, draftInDiff, firstChangedLine, hunkRange, lineInHunks, sideLines } from "./diff-utils";

function hunk(header: string, body: string[]): Hunk {
  return { id: "h1", path: "a.ts", header, patch: [header, ...body].join("\n"), fingerprint: "f1" } as unknown as Hunk;
}

const sample = hunk("@@ -10,3 +10,4 @@", [" keep", "-old", "+new one", "+new two", " tail"]);

describe("reading path after new commits", () => {
  const group = (id: string, kind: ReviewGroup["kind"], ...hunkIds: string[]): ReviewGroup => ({ id, title: id, why: id, kind, hunkIds });
  const current = (hunks: [string, string][]) => hunks.map(([id, fingerprint]) => ({ id, fingerprint }));
  const review = (hunks: [string, string][], groups: ReviewGroup[], hunkFingerprints: Record<string, string> | null) =>
    ({
      pr: {
        headSha: "new",
        hunks: current(hunks),
        files: [{ index: 0, path: "a.ts", hunkIds: hunks.map(([id]) => id) }],
      },
      completed: { headSha: "old", hunkFingerprints, result: { groups } },
    }) as unknown as ReviewGet;

  it("follows a hunk by content when an earlier file moves its id", () => {
    const groups = displayGroups(
      review(
        [["f0h0", "new-file"], ["f1h1", "logic"], ["f1h2", "lockfile"]],
        [group("core", "core", "f0h0"), group("noise", "noise", "f0h1")],
        { f0h0: "logic", f0h1: "lockfile" },
      ),
    );
    expect(groups.map((g) => [g.id, g.hunkIds])).toEqual([
      ["core", ["f1h1"]],
      ["noise", ["f1h2"]],
      ["__new", ["f0h0"]],
    ]);
  });

  it("moves a hunk whose content changed out of its old group", () => {
    const groups = displayGroups(review([["f0h0", "edited"]], [group("core", "core", "f0h0")], { f0h0: "logic" }));
    expect(groups.map((g) => [g.id, g.hunkIds])).toEqual([["__new", ["f0h0"]]]);
  });

  it("shows identical hunks once each", () => {
    const groups = displayGroups(
      review(
        [["f0h0", "same"], ["f0h1", "same"], ["f0h2", "same"]],
        [group("one", "core", "f0h0"), group("two", "tests", "f0h1")],
        { f0h0: "same", f0h1: "same" },
      ),
    );
    expect(groups.flatMap((g) => g.hunkIds).sort()).toEqual(["f0h0", "f0h1", "f0h2"]);
  });

  it("falls back to files when an old analysis saved no fingerprints", () => {
    const groups = displayGroups(review([["f0h0", "logic"]], [group("noise", "noise", "f0h0")], null));
    expect(groups.map((g) => [g.id, g.hunkIds])).toEqual([["file-0", ["f0h0"]]]);
  });
});

describe("where a pending comment shows", () => {
  const comment = { side: "RIGHT", line: 11, headSha: "head" } as PendingComment;

  it("shows inline when written on this commit and the line is in the diff", () => {
    expect(draftInDiff(comment, "head", [sample])).toBe(true);
  });

  it("does not show inline when written on another commit", () => {
    expect(draftInDiff(comment, "newer", [sample])).toBe(false);
  });

  it("does not show inline when the line left the diff", () => {
    expect(draftInDiff({ ...comment, line: 500 }, "head", [sample])).toBe(false);
  });
});

describe("hunk line helpers", () => {
  it("reads the ranges from the header", () => {
    expect(hunkRange(sample)).toEqual({ oldStart: 10, oldEnd: 12, newStart: 10, newEnd: 13 });
  });

  it("checks line membership per side", () => {
    expect(lineInHunks([sample], "RIGHT", 13)).toBe(true);
    expect(lineInHunks([sample], "RIGHT", 14)).toBe(false);
    expect(lineInHunks([sample], "LEFT", 12)).toBe(true);
    expect(lineInHunks([sample], "LEFT", 13)).toBe(false);
  });

  it("finds the first changed line", () => {
    expect(firstChangedLine(sample)).toEqual({ side: "LEFT", line: 11 });
  });

  it("returns the source lines of a side", () => {
    expect(sideLines([sample], "RIGHT", 11, 12)).toEqual(["new one", "new two"]);
    expect(sideLines([sample], "LEFT", 11, 11)).toEqual(["old"]);
  });

  it("returns null when a line is outside the hunks", () => {
    expect(sideLines([sample], "RIGHT", 50, 51)).toBeNull();
  });
});
