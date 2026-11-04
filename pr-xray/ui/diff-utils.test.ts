import { describe, expect, it } from "vitest";
import type { Hunk } from "../shared/schema";
import { firstChangedLine, hunkRange, lineInHunks, sideLines } from "./diff-utils";

function hunk(header: string, body: string[]): Hunk {
  return { id: "h1", path: "a.ts", header, patch: [header, ...body].join("\n"), fingerprint: "f1" } as unknown as Hunk;
}

const sample = hunk("@@ -10,3 +10,4 @@", [" keep", "-old", "+new one", "+new two", " tail"]);

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
