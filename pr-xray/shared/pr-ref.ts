// Parsing and formatting of pull request references. Dependency-free so the
// app can import it at runtime.
import type { PrRef } from "./schema";

const PR_URL =
  /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/u;
const PR_SHORT = /^([\w.-]+)\/([\w.-]+)#(\d+)$/u;
const PR_SUBPATH = /^([\w.-]+)\/([\w.-]+)\/(\d+)\/?$/u;

/** Accepts a GitHub PR URL or `owner/repo#123`. */
export function parsePrRef(input: string): PrRef | null {
  const text = input.trim();
  const match = PR_URL.exec(text) ?? PR_SHORT.exec(text);
  if (match === null) return null;
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

/** The review page's subPath: `owner/repo/123`. */
export function prRefToSubPath(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}/${ref.number}`;
}

export function parsePrSubPath(subPath: string): PrRef | null {
  const match = PR_SUBPATH.exec(subPath);
  if (match === null) return null;
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

export function prRefKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
}

export function prRefUrl(ref: PrRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}

export const REVIEW_PANEL_PATH = "review";
