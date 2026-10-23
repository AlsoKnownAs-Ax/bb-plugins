// Starts visible agent threads that fix review feedback on the PR branch.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PrDetails, ReviewThread, StoredComment } from "../shared/schema";
import { stripMarker } from "./comments";
import { findProject, personalProjectId } from "./projects";

export interface FixThread {
  threadId: string;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

async function spawnFix(bb: BbPluginApi, pr: PrDetails, title: string, prompt: string): Promise<FixThread> {
  const project = await findProject(bb, pr.ref);
  const base = {
    projectId: project?.projectId ?? (await personalProjectId(bb)),
    prompt,
    title,
    pluginMetadata: { role: "fix", pr: `${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number}` },
  };
  if (project?.hostId) {
    try {
      // An isolated worktree based on the PR branch keeps the user's checkout untouched.
      const thread = await bb.sdk.threads.spawn({
        ...base,
        environment: {
          type: "host",
          hostId: project.hostId,
          workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: pr.headRef } },
        },
      });
      return { threadId: thread.id };
    } catch (error) {
      bb.log.warn(`worktree on ${pr.headRef} failed, using the project default: ${String(error)}`);
    }
  }
  const thread = await bb.sdk.threads.spawn({ ...base, environment: { type: "project-default" } });
  return { threadId: thread.id };
}

function branchInstructions(pr: PrDetails): string {
  return [
    `The PR branch is \`${pr.headRef}\` (base \`${pr.baseRef}\`), PR ${pr.url}.`,
    `First make sure you are working on top of the latest \`origin/${pr.headRef}\` (fetch it; check it out or rebase onto it if needed).`,
    `When the changes are done and verified, commit them and push to the PR branch with \`git push origin HEAD:${pr.headRef}\`.`,
  ].join("\n");
}

export async function fixDiffComments(
  bb: BbPluginApi,
  pr: PrDetails,
  threads: ReviewThread[],
  tags: Map<number, string>,
): Promise<FixThread> {
  const items = threads.map((thread, index) => {
    const range = thread.startLine && thread.startLine !== thread.line ? `${thread.startLine}-${thread.line}` : `${thread.line}`;
    const conversation = thread.comments
      .map((comment) => {
        const tag = tags.get(comment.databaseId);
        return `**@${comment.author}**${tag ? ` [${tag}]` : ""}:\n${quote(stripMarker(comment.body))}`;
      })
      .join("\n\n");
    return `### ${index + 1}. \`${thread.path}\` line ${range} (${thread.side === "LEFT" ? "old" : "new"} side)\n${conversation}`;
  });
  const prompt = [
    `Fix the open review comments on PR ${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number} "${pr.title}".`,
    "",
    branchInstructions(pr),
    "",
    "Address every comment below. If a comment is a question or you disagree, explain why instead of changing code. Do not resolve threads on GitHub; the author will.",
    "",
    ...items,
  ].join("\n");
  return spawnFix(bb, pr, `Fix review comments: ${pr.ref.repo}#${pr.ref.number}`, prompt);
}

export async function fixDiagramComments(
  bb: BbPluginApi,
  pr: PrDetails,
  comments: StoredComment[],
  diagramTitles: Map<string, string>,
): Promise<FixThread> {
  const items = comments.map(
    (comment, index) =>
      `### ${index + 1}. On "${comment.nodeLabel}" in diagram "${diagramTitles.get(comment.diagramId ?? "") ?? comment.diagramId}"${comment.tag ? ` [${comment.tag}]` : ""}\n${quote(comment.body)}`,
  );
  const prompt = [
    `The author of PR ${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number} "${pr.title}" reviewed its design diagrams and believes parts of the design are wrong.`,
    "",
    branchInstructions(pr),
    "",
    "PLAN FIRST. Read the relevant code, then reply with a short redesign plan, one section per comment below (what changes, which files, risks). Then STOP and wait. For each item the author will approve, adjust or skip. Only implement the items they approve.",
    "",
    ...items,
  ].join("\n");
  return spawnFix(bb, pr, `Redesign from diagram feedback: ${pr.ref.repo}#${pr.ref.number}`, prompt);
}

export async function fixSingleComment(bb: BbPluginApi, pr: PrDetails, thread: ReviewThread, tag: string | null) {
  return fixDiffComments(bb, pr, [thread], new Map(tag ? [[thread.comments[0]!.databaseId, tag]] : []));
}

export { personalProjectId };
