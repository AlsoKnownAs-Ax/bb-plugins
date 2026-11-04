// Whether an agent is about to read text written by someone other than the user.
import type { PrDetails } from "../shared/schema";

export type AgentJob = "analysis" | "chat";

export function needsAgentWarning(pr: PrDetails, job: AgentJob): boolean {
  if (!pr.isOwnPr) return true;
  // Analysis reads the PR's own content. Chat also reads its review threads.
  const viewer = pr.viewer.toLowerCase();
  return job === "chat" && pr.threads.some((thread) => thread.comments.some((comment) => comment.author.toLowerCase() !== viewer));
}
