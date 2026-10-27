// GitHub access: a token from settings, else the user's `gh` login.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type {
  DraftComment,
  Hunk,
  PrDetails,
  PrFile,
  PrRef,
  ReviewThread,
} from "../shared/schema";
import { prRefUrl } from "../shared/pr-ref";

const run = promisify(execFile);
const API = "https://api.github.com";
const GH_CANDIDATES = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"];

export interface GithubIdentity {
  login: string;
  source: "token" | "gh";
}

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

async function ghCliToken(): Promise<string | null> {
  for (const bin of GH_CANDIDATES) {
    try {
      const { stdout } = await run(bin, ["auth", "token"], { timeout: 10_000 });
      const token = stdout.trim();
      if (token !== "") return token;
    } catch {
      // Try the next location.
    }
  }
  return null;
}

export function createGithub(getSettingsToken: () => Promise<string | undefined>) {
  let cachedGhToken: string | null = null;

  async function credentials(): Promise<{ token: string; source: "token" | "gh" }> {
    const configured = (await getSettingsToken())?.trim();
    if (configured) return { token: configured, source: "token" };
    cachedGhToken ??= await ghCliToken();
    if (cachedGhToken === null) {
      throw new GithubError(
        "No GitHub credentials. Set a token in PR X-ray settings or run `gh auth login`.",
        401,
      );
    }
    return { token: cachedGhToken, source: "gh" };
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const { token } = await credentials();
    const response = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      if (response.status === 401) cachedGhToken = null;
      const text = await response.text();
      let message = text;
      try {
        const parsed = JSON.parse(text) as { message?: string; errors?: unknown };
        message = [parsed.message, parsed.errors ? JSON.stringify(parsed.errors) : ""]
          .filter(Boolean)
          .join(" ");
      } catch {
        // Keep the raw text.
      }
      throw new GithubError(`GitHub ${method} ${path} failed (${response.status}): ${message}`, response.status);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const result = await request<{ data?: T; errors?: { message: string }[] }>(
      "POST",
      "/graphql",
      { query, variables },
    );
    if (result.errors?.length) {
      throw new GithubError(result.errors.map((error) => error.message).join("; "), 400);
    }
    return result.data as T;
  }

  async function identity(): Promise<GithubIdentity> {
    const { source } = await credentials();
    const user = await request<{ login: string }>("GET", "/user");
    return { login: user.login, source };
  }

  async function listFiles(ref: PrRef): Promise<RawFile[]> {
    const files: RawFile[] = [];
    // GitHub caps this listing at 3000 files.
    for (let page = 1; page <= 30; page += 1) {
      const batch = await request<RawFile[]>(
        "GET",
        `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=100&page=${page}`,
      );
      files.push(...batch);
      if (batch.length < 100) break;
    }
    return files;
  }

  async function listThreads(ref: PrRef): Promise<ReviewThread[]> {
    const threads: ReviewThread[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const data: ThreadsQuery = await graphql<ThreadsQuery>(THREADS_QUERY, {
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
        cursor,
      });
      const connection = data.repository.pullRequest.reviewThreads;
      for (const node of connection.nodes) {
        threads.push({
          id: node.id,
          path: node.path,
          line: node.line ?? node.originalLine,
          startLine: node.startLine ?? node.originalStartLine,
          side: node.diffSide === "LEFT" ? "LEFT" : "RIGHT",
          isResolved: node.isResolved,
          isOutdated: node.isOutdated,
          comments: node.comments.nodes.map((comment) => ({
            id: comment.id,
            databaseId: comment.databaseId,
            author: comment.author?.login ?? "ghost",
            body: comment.body,
            createdAt: comment.createdAt,
            url: comment.url,
          })),
        });
      }
      if (!connection.pageInfo.hasNextPage) break;
      cursor = connection.pageInfo.endCursor;
    }
    return threads;
  }

  async function loadPr(ref: PrRef): Promise<PrDetails> {
    const [pr, rawFiles, threads, viewer] = await Promise.all([
      request<RawPull>("GET", `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`),
      listFiles(ref),
      listThreads(ref),
      identity(),
    ]);
    const files: PrFile[] = [];
    const hunks: Hunk[] = [];
    rawFiles.forEach((file, index) => {
      const fileHunks = splitHunks(file.patch ?? "", index, file.filename);
      hunks.push(...fileHunks);
      files.push({
        index,
        path: file.filename,
        previousPath: file.previous_filename ?? null,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        hasPatch: file.patch !== undefined && file.patch !== "",
        hunkIds: fileHunks.map((hunk) => hunk.id),
      });
    });
    return {
      ref,
      url: pr.html_url ?? prRefUrl(ref),
      title: pr.title,
      body: pr.body ?? "",
      author: pr.user?.login ?? "ghost",
      state: pr.merged_at ? "merged" : pr.state,
      draft: pr.draft ?? false,
      headSha: pr.head.sha,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      viewer: viewer.login,
      isOwnPr: viewer.login.toLowerCase() === (pr.user?.login ?? "").toLowerCase(),
      files,
      hunks,
      threads,
    };
  }

  async function headSha(ref: PrRef): Promise<string> {
    const pr = await request<RawPull>("GET", `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
    return pr.head.sha;
  }

  function commentPayload(comment: DraftComment) {
    return {
      path: comment.path,
      line: comment.line,
      side: comment.side,
      ...(comment.startLine !== null && comment.startLine !== comment.line
        ? { start_line: comment.startLine, start_side: comment.startSide ?? comment.side }
        : {}),
      body: comment.body,
    };
  }

  async function createComment(ref: PrRef, commitId: string, comment: DraftComment) {
    return request<RawReviewComment>(
      "POST",
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments`,
      { commit_id: commitId, ...commentPayload(comment) },
    );
  }

  async function submitReview(
    ref: PrRef,
    commitId: string,
    event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
    body: string,
    comments: DraftComment[],
  ): Promise<RawReviewComment[]> {
    const review = await request<{ id: number }>(
      "POST",
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`,
      {
        commit_id: commitId,
        event,
        ...(body.trim() === "" ? {} : { body }),
        comments: comments.map(commentPayload),
      },
    );
    if (comments.length === 0) return [];
    return request<RawReviewComment[]>(
      "GET",
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews/${review.id}/comments?per_page=100`,
    );
  }

  async function reply(ref: PrRef, commentId: number, body: string) {
    return request<RawReviewComment>(
      "POST",
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments/${commentId}/replies`,
      { body },
    );
  }

  async function getComment(ref: PrRef, commentId: number) {
    return request<RawReviewComment>(
      "GET",
      `/repos/${ref.owner}/${ref.repo}/pulls/comments/${commentId}`,
    );
  }

  async function updateCommentBody(ref: PrRef, commentId: number, body: string) {
    return request<RawReviewComment>(
      "PATCH",
      `/repos/${ref.owner}/${ref.repo}/pulls/comments/${commentId}`,
      { body },
    );
  }

  async function setThreadResolved(threadId: string, resolved: boolean) {
    const mutation = resolved
      ? `mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id } } }`
      : `mutation($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { id } } }`;
    await graphql(mutation, { id: threadId });
  }

  async function fileContent(ref: PrRef, path: string, sha: string): Promise<string | null> {
    try {
      const file = await request<{ content?: string; encoding?: string }>(
        "GET",
        `/repos/${ref.owner}/${ref.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`,
      );
      if (file.content === undefined || file.encoding !== "base64") return null;
      return Buffer.from(file.content, "base64").toString("utf8");
    } catch (error) {
      if (error instanceof GithubError && error.status === 404) return null;
      throw error;
    }
  }

  async function baseSha(ref: PrRef): Promise<string> {
    const pr = await request<RawPull>("GET", `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`);
    return pr.base.sha;
  }

  return {
    identity,
    loadPr,
    headSha,
    baseSha,
    createComment,
    submitReview,
    reply,
    getComment,
    updateCommentBody,
    setThreadResolved,
    fileContent,
  };
}

export type Github = ReturnType<typeof createGithub>;

/** Splits a GitHub file patch into hunks with stable ids `f<file>h<hunk>`. */
export function splitHunks(patch: string, fileIndex: number, path: string): Hunk[] {
  if (patch === "") return [];
  const lines = patch.split("\n");
  const hunks: Hunk[] = [];
  let current: string[] | null = null;
  const flush = () => {
    if (current === null) return;
    const body = current.slice(1);
    hunks.push({
      id: `f${fileIndex}h${hunks.length}`,
      // Path + body without the @@ line numbers, so the hash survives commits that only shift the hunk.
      fingerprint: createHash("sha1").update(`${path}\n${body.join("\n")}`).digest("hex").slice(0, 20),
      fileIndex,
      header: current[0]!,
      patch: current.join("\n"),
      additions: body.filter((line) => line.startsWith("+")).length,
      deletions: body.filter((line) => line.startsWith("-")).length,
    });
  };
  for (const line of lines) {
    if (line.startsWith("@@")) {
      flush();
      current = [line];
    } else if (current !== null) {
      current.push(line);
    }
  }
  flush();
  return hunks;
}

interface RawPull {
  html_url?: string;
  title: string;
  body: string | null;
  state: string;
  draft?: boolean;
  merged_at?: string | null;
  user: { login: string } | null;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
}

interface RawFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface RawReviewComment {
  id: number;
  body: string;
  html_url: string;
  path: string;
  line: number | null;
  original_line?: number | null;
}

interface ThreadsQuery {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          path: string;
          line: number | null;
          originalLine: number | null;
          startLine: number | null;
          originalStartLine: number | null;
          diffSide: string;
          isResolved: boolean;
          isOutdated: boolean;
          comments: {
            nodes: {
              id: string;
              databaseId: number;
              body: string;
              createdAt: string;
              url: string;
              author: { login: string } | null;
            }[];
          };
        }[];
      };
    };
  };
}

const THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id path line originalLine startLine originalStartLine diffSide isResolved isOutdated
          comments(first: 50) {
            nodes { id databaseId body createdAt url author { login } }
          }
        }
      }
    }
  }
}`;
