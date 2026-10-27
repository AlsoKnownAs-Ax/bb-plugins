// Plugin-owned SQLite storage: reviews, analyses, comments, pending drafts.
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  analysisResultSchema,
  type AnalysisRecord,
  type AnalysisResult,
  type CommentTag,
  type DraftComment,
  type PendingComment,
  type PrRef,
  type ReviewSummary,
  type StoredComment,
} from "../shared/schema";
import { prRefKey, prRefUrl } from "../shared/pr-ref";

type Db = ReturnType<BbPluginApi["storage"]["database"]>;

const MIGRATIONS = [
  `CREATE TABLE reviews (
     key TEXT PRIMARY KEY, owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
     title TEXT NOT NULL, url TEXT NOT NULL, ticket_url TEXT, last_opened_at TEXT NOT NULL)`,
  `CREATE TABLE analyses (
     id TEXT PRIMARY KEY, key TEXT NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
     head_sha TEXT NOT NULL, status TEXT NOT NULL, error TEXT, result_json TEXT,
     worker_thread_id TEXT, diff_only INTEGER NOT NULL DEFAULT 0, ticket_url TEXT,
     created_at TEXT NOT NULL, finished_at TEXT)`,
  `CREATE INDEX analyses_key ON analyses (key, created_at)`,
  `CREATE TABLE comments (
     id TEXT PRIMARY KEY, source TEXT NOT NULL, key TEXT NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,
     number INTEGER NOT NULL, head_sha TEXT NOT NULL, body TEXT NOT NULL, tag TEXT, status TEXT NOT NULL,
     github_comment_id INTEGER, github_url TEXT, path TEXT, line INTEGER,
     analysis_id TEXT, diagram_id TEXT, node_id TEXT, node_label TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX comments_key ON comments (key, created_at)`,
  `CREATE TABLE pending_comments (id TEXT PRIMARY KEY, key TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE viewed_groups (analysis_id TEXT NOT NULL, group_id TEXT NOT NULL, PRIMARY KEY (analysis_id, group_id))`,
  // Viewed state per hunk content, so it survives new commits and re-analyses.
  `DROP TABLE viewed_groups`,
  `CREATE TABLE viewed_hunks (key TEXT NOT NULL, path TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY (key, fingerprint))`,
];

interface CommentRow {
  id: string;
  source: "diff" | "diagram";
  owner: string;
  repo: string;
  number: number;
  head_sha: string;
  body: string;
  tag: string | null;
  status: "open" | "resolved" | "outdated";
  github_comment_id: number | null;
  github_url: string | null;
  path: string | null;
  line: number | null;
  analysis_id: string | null;
  diagram_id: string | null;
  node_id: string | null;
  node_label: string | null;
  created_at: string;
  updated_at: string;
}

interface AnalysisRow {
  id: string;
  owner: string;
  repo: string;
  number: number;
  head_sha: string;
  status: "running" | "done" | "failed";
  error: string | null;
  result_json: string | null;
  worker_thread_id: string | null;
  diff_only: number;
  ticket_url: string | null;
  created_at: string;
  finished_at: string | null;
}

const now = () => new Date().toISOString();

function toComment(row: CommentRow): StoredComment {
  return {
    id: row.id,
    source: row.source,
    ref: { owner: row.owner, repo: row.repo, number: row.number },
    headSha: row.head_sha,
    body: row.body,
    tag: row.tag as CommentTag | null,
    status: row.status,
    githubCommentId: row.github_comment_id,
    githubUrl: row.github_url,
    path: row.path,
    line: row.line,
    analysisId: row.analysis_id,
    diagramId: row.diagram_id,
    nodeId: row.node_id,
    nodeLabel: row.node_label,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAnalysis(row: AnalysisRow): AnalysisRecord {
  let result: AnalysisResult | null = null;
  if (row.result_json !== null) {
    const parsed = analysisResultSchema.safeParse(JSON.parse(row.result_json));
    result = parsed.success ? parsed.data : null;
  }
  return {
    id: row.id,
    ref: { owner: row.owner, repo: row.repo, number: row.number },
    headSha: row.head_sha,
    status: row.status,
    error: row.error,
    result,
    workerThreadId: row.worker_thread_id,
    diffOnly: row.diff_only === 1,
    ticketUrl: row.ticket_url,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

export function createStore(bb: BbPluginApi) {
  const db: Db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  return {
    touchReview(ref: PrRef, title: string, url = prRefUrl(ref)) {
      db.prepare(
        `INSERT INTO reviews (key, owner, repo, number, title, url, last_opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET title = excluded.title, url = excluded.url, last_opened_at = excluded.last_opened_at`,
      ).run(prRefKey(ref), ref.owner, ref.repo, ref.number, title, url, now());
    },

    setTicketOverride(ref: PrRef, ticketUrl: string | null) {
      db.prepare(`UPDATE reviews SET ticket_url = ? WHERE key = ?`).run(ticketUrl, prRefKey(ref));
    },

    ticketOverride(ref: PrRef): string | null {
      const row = db.prepare(`SELECT ticket_url FROM reviews WHERE key = ?`).get(prRefKey(ref)) as
        | { ticket_url: string | null }
        | undefined;
      return row?.ticket_url ?? null;
    },

    recentReviews(limit = 30): ReviewSummary[] {
      const rows = db
        .prepare(
          `SELECT r.*, (SELECT status FROM analyses a WHERE a.key = r.key ORDER BY created_at DESC LIMIT 1) AS analysis_status
           FROM reviews r ORDER BY last_opened_at DESC LIMIT ?`,
        )
        .all(limit) as {
        owner: string;
        repo: string;
        number: number;
        title: string;
        url: string;
        last_opened_at: string;
        analysis_status: "running" | "done" | "failed" | null;
      }[];
      return rows.map((row) => ({
        ref: { owner: row.owner, repo: row.repo, number: row.number },
        title: row.title,
        url: row.url,
        lastOpenedAt: row.last_opened_at,
        analysisStatus: row.analysis_status ?? "none",
      }));
    },

    // ---- analyses ----
    createAnalysis(input: { ref: PrRef; headSha: string; diffOnly: boolean; ticketUrl: string | null }) {
      const id = `an_${randomUUID().slice(0, 12)}`;
      db.prepare(
        `INSERT INTO analyses (id, key, owner, repo, number, head_sha, status, diff_only, ticket_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      ).run(
        id,
        prRefKey(input.ref),
        input.ref.owner,
        input.ref.repo,
        input.ref.number,
        input.headSha,
        input.diffOnly ? 1 : 0,
        input.ticketUrl,
        now(),
      );
      return id;
    },

    setAnalysisWorker(id: string, threadId: string) {
      db.prepare(`UPDATE analyses SET worker_thread_id = ? WHERE id = ?`).run(threadId, id);
    },

    completeAnalysis(id: string, result: AnalysisResult) {
      db.prepare(
        `UPDATE analyses SET status = 'done', result_json = ?, error = NULL, finished_at = ? WHERE id = ?`,
      ).run(JSON.stringify(result), now(), id);
    },

    failAnalysis(id: string, error: string) {
      db.prepare(
        `UPDATE analyses SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'running'`,
      ).run(error, now(), id);
    },

    analysis(id: string): AnalysisRecord | null {
      const row = db.prepare(`SELECT * FROM analyses WHERE id = ?`).get(id) as AnalysisRow | undefined;
      return row === undefined ? null : toAnalysis(row);
    },

    /** Latest analysis for a PR, preferring one for `headSha` when given. */
    latestAnalysis(ref: PrRef, headSha?: string): AnalysisRecord | null {
      const key = prRefKey(ref);
      const row = (headSha === undefined
        ? undefined
        : db
            .prepare(`SELECT * FROM analyses WHERE key = ? AND head_sha = ? ORDER BY created_at DESC LIMIT 1`)
            .get(key, headSha)) as AnalysisRow | undefined;
      const fallback =
        row ??
        (db.prepare(`SELECT * FROM analyses WHERE key = ? ORDER BY created_at DESC LIMIT 1`).get(key) as
          | AnalysisRow
          | undefined);
      return fallback === undefined ? null : toAnalysis(fallback);
    },

    /** Most recent completed analysis, used to keep showing results while a new one runs. */
    latestCompletedAnalysis(ref: PrRef): AnalysisRecord | null {
      const row = db
        .prepare(`SELECT * FROM analyses WHERE key = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1`)
        .get(prRefKey(ref)) as AnalysisRow | undefined;
      return row === undefined ? null : toAnalysis(row);
    },

    runningAnalyses(): AnalysisRecord[] {
      const rows = db.prepare(`SELECT * FROM analyses WHERE status = 'running'`).all() as AnalysisRow[];
      return rows.map(toAnalysis);
    },

    // ---- viewed hunks ----
    viewedHunks(ref: PrRef): { path: string; fingerprint: string }[] {
      return db.prepare(`SELECT path, fingerprint FROM viewed_hunks WHERE key = ?`).all(prRefKey(ref)) as {
        path: string;
        fingerprint: string;
      }[];
    },

    /** Marking viewed also forgets older versions of those files' hunks (`current` = the PR's fingerprints now). */
    setHunksViewed(ref: PrRef, hunks: { path: string; fingerprint: string }[], viewed: boolean, current: Set<string>) {
      const key = prRefKey(ref);
      if (!viewed) {
        const remove = db.prepare(`DELETE FROM viewed_hunks WHERE key = ? AND fingerprint = ?`);
        for (const hunk of hunks) remove.run(key, hunk.fingerprint);
        return;
      }
      const insert = db.prepare(`INSERT OR IGNORE INTO viewed_hunks (key, path, fingerprint) VALUES (?, ?, ?)`);
      for (const hunk of hunks) insert.run(key, hunk.path, hunk.fingerprint);
      const remove = db.prepare(`DELETE FROM viewed_hunks WHERE key = ? AND fingerprint = ?`);
      for (const row of this.viewedHunks(ref)) {
        if (!current.has(row.fingerprint) && hunks.some((hunk) => hunk.path === row.path)) remove.run(key, row.fingerprint);
      }
    },

    // ---- pending review comments ----
    pendingComments(ref: PrRef): PendingComment[] {
      const rows = db
        .prepare(`SELECT id, json, created_at FROM pending_comments WHERE key = ? ORDER BY created_at`)
        .all(prRefKey(ref)) as { id: string; json: string; created_at: string }[];
      return rows.map((row) => ({ ...(JSON.parse(row.json) as DraftComment), id: row.id, createdAt: row.created_at }));
    },

    addPendingComment(ref: PrRef, comment: DraftComment): PendingComment {
      const id = `pc_${randomUUID().slice(0, 12)}`;
      const createdAt = now();
      db.prepare(`INSERT INTO pending_comments (id, key, json, created_at) VALUES (?, ?, ?, ?)`).run(
        id,
        prRefKey(ref),
        JSON.stringify(comment),
        createdAt,
      );
      return { ...comment, id, createdAt };
    },

    updatePendingComment(id: string, body: string) {
      const row = db.prepare(`SELECT json FROM pending_comments WHERE id = ?`).get(id) as { json: string } | undefined;
      if (row === undefined) return;
      const comment = { ...(JSON.parse(row.json) as DraftComment), body };
      db.prepare(`UPDATE pending_comments SET json = ? WHERE id = ?`).run(JSON.stringify(comment), id);
    },

    removePendingComment(id: string) {
      db.prepare(`DELETE FROM pending_comments WHERE id = ?`).run(id);
    },

    clearPendingComments(ref: PrRef) {
      db.prepare(`DELETE FROM pending_comments WHERE key = ?`).run(prRefKey(ref));
    },

    // ---- stored comments ----
    insertComment(
      input: Omit<StoredComment, "id" | "createdAt" | "updatedAt" | "tag" | "status"> & {
        tag?: CommentTag | null;
        status?: StoredComment["status"];
      },
    ): StoredComment {
      const id = `cm_${randomUUID().slice(0, 12)}`;
      const at = now();
      db.prepare(
        `INSERT INTO comments (id, source, key, owner, repo, number, head_sha, body, tag, status,
           github_comment_id, github_url, path, line, analysis_id, diagram_id, node_id, node_label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.source,
        prRefKey(input.ref),
        input.ref.owner,
        input.ref.repo,
        input.ref.number,
        input.headSha,
        input.body,
        input.tag ?? null,
        input.status ?? "open",
        input.githubCommentId,
        input.githubUrl,
        input.path,
        input.line,
        input.analysisId,
        input.diagramId,
        input.nodeId,
        input.nodeLabel,
        at,
        at,
      );
      return this.comment(id)!;
    },

    comment(id: string): StoredComment | null {
      const row = db.prepare(`SELECT * FROM comments WHERE id = ?`).get(id) as CommentRow | undefined;
      return row === undefined ? null : toComment(row);
    },

    commentByGithubId(githubCommentId: number): StoredComment | null {
      const row = db.prepare(`SELECT * FROM comments WHERE github_comment_id = ?`).get(githubCommentId) as
        | CommentRow
        | undefined;
      return row === undefined ? null : toComment(row);
    },

    commentsForPr(ref: PrRef, source?: "diff" | "diagram"): StoredComment[] {
      const rows = (source === undefined
        ? db.prepare(`SELECT * FROM comments WHERE key = ? ORDER BY created_at`).all(prRefKey(ref))
        : db
            .prepare(`SELECT * FROM comments WHERE key = ? AND source = ? ORDER BY created_at`)
            .all(prRefKey(ref), source)) as CommentRow[];
      return rows.map(toComment);
    },


    queryComments(filter: {
      since?: string;
      repo?: string;
      source?: "diff" | "diagram";
      tag?: string;
      limit: number;
    }): StoredComment[] {
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      if (filter.since) {
        clauses.push("created_at >= ?");
        params.push(filter.since);
      }
      if (filter.repo) {
        const [owner, repo] = filter.repo.toLowerCase().split("/");
        clauses.push("lower(owner) = ? AND lower(repo) = ?");
        params.push(owner ?? "", repo ?? "");
      }
      if (filter.source) {
        clauses.push("source = ?");
        params.push(filter.source);
      }
      if (filter.tag) {
        clauses.push("tag = ?");
        params.push(filter.tag);
      }
      const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
      const rows = db
        .prepare(`SELECT * FROM comments ${where} ORDER BY created_at DESC LIMIT ?`)
        .all(...params, filter.limit) as CommentRow[];
      return rows.map(toComment);
    },

    updateComment(id: string, patch: Partial<Pick<StoredComment, "tag" | "status" | "body">>) {
      const current = this.comment(id);
      if (current === null) return null;
      db.prepare(`UPDATE comments SET tag = ?, status = ?, body = ?, updated_at = ? WHERE id = ?`).run(
        patch.tag === undefined ? current.tag : patch.tag,
        patch.status ?? current.status,
        patch.body ?? current.body,
        now(),
        id,
      );
      return this.comment(id);
    },

    deleteComment(id: string) {
      db.prepare(`DELETE FROM comments WHERE id = ?`).run(id);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
