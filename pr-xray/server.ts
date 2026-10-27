// PR X-ray backend: GitHub access, hidden analysis workers, comment storage,
// fix threads, the `bb pr-xray` CLI and the agent tools.
import { type BbPluginApi, PluginCliError, cliCommand, defineCli } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract } from "./shared/contract";
import { parsePrRef, prRefKey, prRefToSubPath, REVIEW_PANEL_PATH } from "./shared/pr-ref";
import type { PrDetails, PrRef } from "./shared/schema";
import { ANALYSIS_TOOL, createAnalysis, findTicketUrl } from "./server/analysis";
import { chatInstructions, createChat } from "./server/chat";
import { COMMENTS_CHANGED, TAGS_TOOL, createComments } from "./server/comments";
import { fixDiagramComments, fixDiffComments, fixSingleComment } from "./server/fix";
import { createGithub, GithubError } from "./server/github";
import { createModels } from "./server/models";
import { createStore } from "./server/store";

export type { rpcContract };

const REVIEW_TOOL = "pr_xray_review";
const PR_CACHE_MS = 20_000;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    githubToken: {
      type: "string",
      label: "GitHub token",
      description:
        "Fine-grained token with Pull requests: read & write and Contents: read. Leave empty to use your `gh` login.",
      secret: true,
    },
    notionProjectProperty: {
      type: "string",
      label: "Notion parent project property",
      description: "Relation property on the ticket page that links to its parent project.",
      default: "Project",
    },
    ticketUrlPattern: {
      type: "string",
      label: "Ticket URL pattern",
      description: "Regular expression that finds the ticket link in the PR description.",
      default: "https://(?:www\\.|app\\.)?notion\\.(?:so|com)/[^\\s)\\]>]+",
    },
  });

  const store = createStore(bb);
  const github = createGithub(async () => (await settings.get()).githubToken as string | undefined);
  const models = createModels(bb);
  const comments = createComments({ bb, store, github, models });
  const analysis = createAnalysis({
    bb,
    store,
    github,
    models,
    settings: async () => {
      const values = await settings.get();
      return { ticketUrlPattern: values.ticketUrlPattern, notionProjectProperty: values.notionProjectProperty };
    },
    onDiagramNodesChanged: (analysisId) => comments.reconcileDiagramPins(analysisId),
  });

  // Short-lived PR cache so realtime refetches don't hammer GitHub.
  const prCache = new Map<string, { at: number; pr: Promise<PrDetails> }>();
  function loadPr(ref: PrRef, fresh = false): Promise<PrDetails> {
    const key = prRefKey(ref);
    const hit = prCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < PR_CACHE_MS) return hit.pr;
    const pr = github.loadPr(ref);
    prCache.set(key, { at: Date.now(), pr });
    pr.catch(() => prCache.delete(key));
    return pr;
  }
  const invalidate = (ref: PrRef) => prCache.delete(prRefKey(ref));

  const chat = createChat({ bb, models, loadPr, analysisFor: (ref) => store.latestCompletedAnalysis(ref) });
  bb.onDispose(() => chat.dispose());

  function reviewLink(ref: PrRef): string {
    const path = `/plugins/${bb.pluginId}/${REVIEW_PANEL_PATH}/${prRefToSubPath(ref)}`;
    const base = bb.server.experimental_appUrl;
    return base ? `${base.replace(/\/$/u, "")}${path}` : path;
  }

  async function openReview(ref: PrRef) {
    const pr = await loadPr(ref);
    store.touchReview(ref, pr.title, pr.url);
    // The user starts the analysis from the review page; opening only reports an existing one.
    const latest = store.latestAnalysis(ref, pr.headSha);
    return { pr, analysis: latest?.headSha === pr.headSha ? latest : null };
  }

  bb.rpc.register(rpcContract, {
    async "review.get"({ ref }) {
      const pr = await loadPr(ref);
      store.touchReview(ref, pr.title, pr.url);
      if (store.latestAnalysis(ref, pr.headSha)?.status === "running") await analysis.reconcile();
      const latest = store.latestAnalysis(ref, pr.headSha);
      const current = latest?.headSha === pr.headSha ? latest : null;
      const completed = current?.status === "done" ? current : store.latestCompletedAnalysis(ref);
      const override = store.ticketOverride(ref);
      const values = await settings.get();
      const fingerprints = new Set(pr.hunks.map((hunk) => hunk.fingerprint));
      const viewedRows = store.viewedHunks(ref);
      return {
        pr,
        current,
        completed,
        viewedHunks: viewedRows.filter((row) => fingerprints.has(row.fingerprint)).map((row) => row.fingerprint),
        changedSinceViewed: [...new Set(viewedRows.filter((row) => !fingerprints.has(row.fingerprint)).map((row) => row.path))],
        pending: store.pendingComments(ref),
        comments: store.commentsForPr(ref),
        ticketUrl: override ?? findTicketUrl(pr.body, values.ticketUrlPattern),
        ticketOverridden: override !== null,
      };
    },
    "review.recent": () => ({ reviews: store.recentReviews() }),
    "review.setTicket"({ ref, url }) {
      store.setTicketOverride(ref, url);
      comments.publish(ref);
      return { ok: true };
    },
    async "analysis.start"({ ref }) {
      const pr = await loadPr(ref, true);
      store.touchReview(ref, pr.title, pr.url);
      return { analysis: await analysis.start(ref, { pr }) };
    },
    async "hunks.setViewed"({ ref, fingerprints, viewed }) {
      const pr = await loadPr(ref);
      const paths = new Map(pr.files.map((file) => [file.index, file.path]));
      const wanted = new Set(fingerprints);
      const hunks = pr.hunks
        .filter((hunk) => wanted.has(hunk.fingerprint))
        .map((hunk) => ({ path: paths.get(hunk.fileIndex)!, fingerprint: hunk.fingerprint }));
      store.setHunksViewed(ref, hunks, viewed, new Set(pr.hunks.map((hunk) => hunk.fingerprint)));
      comments.publish(ref);
      return { ok: true };
    },
    async "file.contents"({ ref, path, previousPath }) {
      const pr = await loadPr(ref);
      const baseSha = await github.baseSha(ref);
      const [oldText, newText] = await Promise.all([
        github.fileContent(ref, previousPath ?? path, baseSha),
        github.fileContent(ref, path, pr.headSha),
      ]);
      return { old: oldText, new: newText };
    },
    async "comment.single"({ ref, draft }) {
      await comments.postSingle(ref, draft);
      invalidate(ref);
      return { ok: true };
    },
    "comment.pendingAdd"({ ref, draft }) {
      const pending = store.addPendingComment(ref, draft);
      comments.publish(ref);
      return pending;
    },
    "comment.pendingUpdate"({ ref, id, body }) {
      store.updatePendingComment(id, body);
      comments.publish(ref);
      return { ok: true };
    },
    "comment.pendingRemove"({ ref, id }) {
      store.removePendingComment(id);
      comments.publish(ref);
      return { ok: true };
    },
    async "review.submit"({ ref, event, body }) {
      const result = await comments.submitReview(ref, event, body);
      invalidate(ref);
      return result;
    },
    async "thread.reply"({ ref, commentDatabaseId, body }) {
      await comments.reply(ref, commentDatabaseId, body);
      invalidate(ref);
      return { ok: true };
    },
    async "thread.resolve"({ ref, threadId, resolved, commentDatabaseIds }) {
      await comments.setThreadResolved(ref, threadId, resolved, commentDatabaseIds);
      invalidate(ref);
      return { ok: true };
    },
    async "comment.setTag"({ commentId, tag }) {
      await comments.setTag(commentId, tag);
      return { ok: true };
    },
    async "comment.autoTag"({ commentId }) {
      await comments.autoTag(commentId);
      return { ok: true };
    },
    async "diagram.addComment"({ ref, analysisId, diagramId, nodeId, body }) {
      const record = store.analysis(analysisId);
      const node = record?.result?.diagrams
        .find((diagram) => diagram.id === diagramId)
        ?.nodes.find((candidate) => candidate.id === nodeId);
      if (!record || !node) throw new Error("That diagram node no longer exists.");
      return comments.addDiagramComment({
        ref,
        headSha: record.headSha,
        analysisId,
        diagramId,
        nodeId,
        nodeLabel: node.label,
        body,
      });
    },
    "diagram.updateComment"({ id, body, status }) {
      const updated = store.updateComment(id, { ...(body ? { body } : {}), ...(status ? { status } : {}) });
      if (updated) comments.publish(updated.ref);
      return { ok: true };
    },
    "diagram.deleteComment"({ id }) {
      const existing = store.comment(id);
      store.deleteComment(id);
      if (existing) comments.publish(existing.ref);
      return { ok: true };
    },
    async "fix.thread"({ ref, threadId }) {
      const pr = await loadPr(ref, true);
      const thread = pr.threads.find((candidate) => candidate.id === threadId);
      if (!thread) throw new Error("That review thread no longer exists.");
      const first = thread.comments[0];
      const tag = first ? (store.commentByGithubId(first.databaseId)?.tag ?? null) : null;
      return fixSingleComment(bb, pr, thread, tag);
    },
    async "fix.allDiff"({ ref }) {
      const pr = await loadPr(ref, true);
      const open = pr.threads.filter(
        (thread) =>
          !thread.isResolved &&
          thread.comments.some((comment) => comment.author.toLowerCase() === pr.viewer.toLowerCase()),
      );
      if (open.length === 0) throw new Error("There are no unresolved review threads with your comments.");
      const tags = new Map<number, string>();
      for (const thread of open) {
        for (const comment of thread.comments) {
          const tag = store.commentByGithubId(comment.databaseId)?.tag;
          if (tag) tags.set(comment.databaseId, tag);
        }
      }
      return fixDiffComments(bb, pr, open, tags);
    },
    async "fix.allDiagram"({ ref }) {
      const pr = await loadPr(ref, true);
      const open = store.commentsForPr(ref, "diagram").filter((comment) => comment.status === "open");
      if (open.length === 0) throw new Error("There are no open diagram comments.");
      const titles = new Map<string, string>();
      for (const comment of open) {
        const diagram = store
          .analysis(comment.analysisId ?? "")
          ?.result?.diagrams.find((candidate) => candidate.id === comment.diagramId);
        if (diagram && comment.diagramId) titles.set(comment.diagramId, diagram.title);
      }
      return fixDiagramComments(bb, pr, open, titles);
    },
    async "chat.get"({ ref }) {
      return { threadId: await chat.get(ref) };
    },
    async "chat.start"({ ref, question }) {
      return { threadId: await chat.start(ref, question) };
    },
    async "chat.reset"({ ref }) {
      await chat.reset(ref);
      return { ok: true };
    },
    async "settings.get"() {
      let identity: { login: string; source: "token" | "gh" } | null = null;
      let identityError: string | null = null;
      try {
        identity = await github.identity();
      } catch (error) {
        identityError = error instanceof Error ? error.message : String(error);
      }
      return { identity, identityError, model: await models.stored(), recommended: await models.recommended() };
    },
    async "settings.setModel"({ selection }) {
      await models.setStored(selection);
      return { ok: true };
    },
  });

  // ---- agent tools -------------------------------------------------------------

  bb.agents.registerTool({
    name: REVIEW_TOOL,
    description:
      "Open a GitHub pull request in PR X-ray and return a link to the review page, where the user can start the grouped-diff and visual analysis. Use when the user asks to review or x-ray a PR.",
    instructions: `When the user asks to review or "x-ray" a GitHub PR, call ${REVIEW_TOOL} with its URL and share the returned link.`,
    presentation: { label: { pending: "Opening PR in PR X-ray", completed: "Opened PR in PR X-ray" } },
    parameters: z.object({ url: z.string().describe("GitHub PR URL or owner/repo#123") }),
    async execute({ url }) {
      const ref = parsePrRef(url);
      if (ref === null) {
        return { content: [{ type: "text", text: `Not a GitHub pull request URL: ${url}` }], isError: true };
      }
      try {
        const { pr, analysis: record } = await openReview(ref);
        const state =
          record?.status === "done"
            ? "The analysis is ready."
            : record?.status === "running"
              ? "The analysis is running (usually 1-3 minutes); the page updates live."
              : "Not analysed yet; the user can start the analysis from the review page.";
        return `Opened "${pr.title}" in PR X-ray. ${state}\nReview page: [${ref.owner}/${ref.repo}#${ref.number}](${reviewLink(ref)})`;
      } catch (error) {
        const message = error instanceof GithubError ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true };
      }
    },
  });

  // Worker tools are offered only to the workers that need them.
  bb.agents.configure((context) => {
    const role = context.pluginMetadata.role;
    const tools = [REVIEW_TOOL];
    if (role === "analysis") tools.push(ANALYSIS_TOOL);
    if (role === "tagging") tools.push(TAGS_TOOL);
    const instructions = chatInstructions(context.pluginMetadata);
    return { tools, skills: [], ...(instructions ? { instructions } : {}) };
  });

  // ---- CLI -----------------------------------------------------------------------

  bb.cli.register(
    defineCli({
      name: "pr-xray",
      summary: "PR X-ray: grouped, visual PR self-review and the comments it records",
      commands: {
        review: cliCommand({
          summary: "Open a PR in PR X-ray",
          positionals: [{ name: "url", description: "GitHub PR URL or owner/repo#123", required: true }],
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run(input) {
            const ref = parsePrRef(input.positionals.url);
            if (ref === null) {
              throw new PluginCliError(`not a GitHub PR: ${input.positionals.url}`, {
                code: "invalid_pr",
                hint: "Pass https://github.com/<owner>/<repo>/pull/<n> or owner/repo#n.",
              });
            }
            const { pr, analysis: record } = await openReview(ref);
            const value = { title: pr.title, analysis: record?.status ?? "none", link: reviewLink(ref) };
            return {
              exitCode: 0,
              stdout: input.options.json ? JSON.stringify(value) : `${pr.title}\nanalysis: ${value.analysis}\n${value.link}`,
            };
          },
        }),
        comments: cliCommand({
          summary: "List recorded review comments (diff and diagram) with tags, for retros",
          options: {
            since: { type: "string", description: "ISO date or duration like 30d / 12w (default 90d)" },
            repo: { type: "string", description: "Only this repository, owner/name" },
            source: { type: "enum", values: ["diff", "diagram"], description: "Only diff or diagram comments" },
            tag: { type: "string", description: "Only this tag" },
            limit: { type: "string", description: "Maximum comments, 1-2000 (default 500)" },
            json: { type: "boolean", description: "Emit JSON" },
          },
          async run(input) {
            const since = parseSince(input.options.since ?? "90d");
            if (since === null) {
              throw new PluginCliError(`invalid --since: ${input.options.since}`, {
                code: "invalid_since",
                hint: "Use an ISO date (2026-01-31) or a duration such as 30d or 12w.",
              });
            }
            const limit = Math.min(2000, Math.max(1, Number(input.options.limit ?? 500) || 500));
            const rows = store.queryComments({
              since,
              ...(input.options.repo ? { repo: input.options.repo } : {}),
              ...(input.options.source ? { source: input.options.source } : {}),
              ...(input.options.tag ? { tag: input.options.tag } : {}),
              limit,
            });
            const items = rows.map((comment) => ({
              id: comment.id,
              source: comment.source,
              repo: `${comment.ref.owner}/${comment.ref.repo}`,
              pr: comment.ref.number,
              tag: comment.tag,
              status: comment.status,
              body: comment.body.slice(0, 4000),
              path: comment.path,
              line: comment.line,
              diagramNode: comment.nodeLabel,
              githubUrl: comment.githubUrl,
              createdAt: comment.createdAt,
            }));
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ since, count: items.length, comments: items }) };
            if (items.length === 0) return { exitCode: 0, stdout: `No comments since ${since}.` };
            const lines = items.map(
              (item) =>
                `${item.createdAt.slice(0, 10)} ${item.repo}#${item.pr} [${item.tag ?? "untagged"}] ${item.source === "diff" ? `${item.path}:${item.line}` : `diagram: ${item.diagramNode}`} — ${item.body.split("\n")[0]!.slice(0, 120)}`,
            );
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
      },
    }),
  );

  bb.log.info("loaded");
}

function parseSince(value: string): string | null {
  const duration = /^(\d+)([dw])$/u.exec(value.trim());
  if (duration) {
    const days = Number(duration[1]) * (duration[2] === "w" ? 7 : 1);
    return new Date(Date.now() - days * 86_400_000).toISOString();
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : new Date(date).toISOString();
}
