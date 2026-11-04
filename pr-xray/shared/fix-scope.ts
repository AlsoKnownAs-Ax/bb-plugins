// Which review comments a fix agent may read. "mine" leaves out everyone else's
// text, because on a public repo anyone can post a comment and prompt-inject the agent.
import type { FixScope, ReviewThread } from "./schema";

export function threadsToFix(threads: ReviewThread[], viewer: string, scope: FixScope): ReviewThread[] {
  const open = threads.filter((thread) => !thread.isResolved);
  if (scope === "all") return open;
  const isViewer = (author: string) => author.toLowerCase() === viewer.toLowerCase();
  return open.flatMap((thread) => {
    const comments = thread.comments.filter((comment) => isViewer(comment.author));
    return comments.length > 0 ? [{ ...thread, comments }] : [];
  });
}
