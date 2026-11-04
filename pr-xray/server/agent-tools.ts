// Which plugin tools an agent thread gets. Workers read untrusted PR content, so
// they only get the tool their job needs.
import { ANALYSIS_TOOL } from "./analysis";
import { TAGS_TOOL } from "./comments";

export const REVIEW_TOOL = "pr_xray_review";

export function agentTools(role: unknown): string[] {
  if (role === undefined) return [REVIEW_TOOL];
  if (role === "analysis") return [ANALYSIS_TOOL];
  if (role === "tagging") return [TAGS_TOOL];
  return [];
}
