// Whether an agent is about to read text written by someone other than the user.
import { isViewer } from "../shared/fix-scope";
import type { PrDetails } from "../shared/schema";

export type AgentJob = "analysis" | "chat" | "fix";

/** The user said no. The caller stops, and this isn't an error worth showing. */
export class AgentDeclined extends Error {}

export function needsAgentWarning(pr: PrDetails, job: AgentJob): boolean {
  if (!pr.isOwnPr) return true;
  // Analysis and fixes read the PR's own content. Chat also reads its review threads.
  return job === "chat" && pr.threads.some((thread) => thread.comments.some((comment) => !isViewer(comment.author, pr.viewer)));
}
