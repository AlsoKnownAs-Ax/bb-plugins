// Patch helpers for rendering hunk subsets and anchoring comments.
import type { Hunk, PrFile, ReviewThread } from "../shared/schema";

export interface HunkRange {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

export function hunkRange(hunk: Hunk): HunkRange {
  const match = HEADER.exec(hunk.header);
  if (match === null) return { oldStart: 0, oldEnd: -1, newStart: 0, newEnd: -1 };
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  return { oldStart, oldEnd: oldStart + oldCount - 1, newStart, newEnd: newStart + newCount - 1 };
}

/** A git patch for one file containing only the given hunks. */
export function filePatch(file: PrFile, hunks: Hunk[]): string {
  const oldPath = file.previousPath ?? file.path;
  const header = [
    `diff --git a/${oldPath} b/${file.path}`,
    file.status === "added" ? "--- /dev/null" : `--- a/${oldPath}`,
    file.status === "removed" ? "+++ /dev/null" : `+++ b/${file.path}`,
  ];
  return `${header.join("\n")}\n${hunks.map((hunk) => hunk.patch.replace(/\n$/u, "")).join("\n")}\n`;
}

export function lineInHunks(hunks: Hunk[], side: "LEFT" | "RIGHT", line: number): boolean {
  return hunks.some((hunk) => {
    const range = hunkRange(hunk);
    return side === "RIGHT"
      ? line >= range.newStart && line <= range.newEnd
      : line >= range.oldStart && line <= range.oldEnd;
  });
}

export function threadVisibleIn(thread: ReviewThread, path: string, hunks: Hunk[]): boolean {
  return thread.path === path && thread.line !== null && lineInHunks(hunks, thread.side, thread.line);
}

/** One side's text for lines start..end: seeds suggestion blocks and chat questions. */
export function sideLines(hunks: Hunk[], side: "LEFT" | "RIGHT", start: number, end: number): string[] | null {
  // Lines that only exist on the other side.
  const other = side === "RIGHT" ? "-" : "+";
  const lines = new Map<number, string>();
  for (const hunk of hunks) {
    const range = hunkRange(hunk);
    let lineNumber = side === "RIGHT" ? range.newStart : range.oldStart;
    for (const raw of hunk.patch.split("\n").slice(1)) {
      if (raw.startsWith(other) || raw.startsWith("\\")) continue;
      lines.set(lineNumber, raw.slice(1));
      lineNumber += 1;
    }
  }
  const out: string[] = [];
  for (let line = start; line <= end; line += 1) {
    const text = lines.get(line);
    if (text === undefined) return null;
    out.push(text);
  }
  return out;
}

/** First changed line of a hunk, for keyboard commenting. */
export function firstChangedLine(hunk: Hunk): { side: "LEFT" | "RIGHT"; line: number } {
  const range = hunkRange(hunk);
  let oldLine = range.oldStart;
  let newLine = range.newStart;
  for (const raw of hunk.patch.split("\n").slice(1)) {
    if (raw.startsWith("+")) return { side: "RIGHT", line: newLine };
    if (raw.startsWith("-")) return { side: "LEFT", line: oldLine };
    oldLine += 1;
    newLine += 1;
  }
  return { side: "RIGHT", line: range.newStart };
}
