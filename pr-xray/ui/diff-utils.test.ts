import { describe, expect, it } from "vitest";
import type { Hunk, PendingComment } from "../shared/schema";
import { draftInDiff, firstChangedLine, hunkRange, lineInHunks, sideLines } from "./diff-utils";

function hunk(header: string, body: string[]): Hunk {
  return { id: "h1", path: "a.ts", header, patch: [header, ...body].join("\n"), fingerprint: "f1" } as unknown as Hunk;
}

const sample = hunk("@@ -10,3 +10,4 @@", [" keep", "-old", "+new one", "+new two", " tail"]);

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
