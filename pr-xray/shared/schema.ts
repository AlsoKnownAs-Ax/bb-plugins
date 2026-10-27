// Wire and storage shapes shared by the server and the app. The app imports
// these as types only, so zod stays out of the frontend bundle unless a
// component imports a runtime value from here.
import { z } from "zod";

import { COMMENT_TAGS } from "./tags";

export { COMMENT_TAGS };
export const commentTagSchema = z.enum(COMMENT_TAGS);
export type CommentTag = z.infer<typeof commentTagSchema>;

export const prRefSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
});
export type PrRef = z.infer<typeof prRefSchema>;

// ---- Analysis (what the hidden worker hands back) -------------------------

export const changeStatusSchema = z.enum([
  "added",
  "modified",
  "removed",
  "unchanged",
]);

export const diagramNodeSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  detail: z.string().max(600).optional(),
  kind: z
    .enum(["component", "function", "data", "external", "actor", "step"])
    .default("component"),
  status: changeStatusSchema.default("unchanged"),
  groupIds: z.array(z.string()).default([]),
});

export const diagramEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().max(120).optional(),
  status: changeStatusSchema.default("unchanged"),
});

export const diagramSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
  kind: z.enum(["flow", "sequence", "data-model", "before-after", "other"]),
  description: z.string().max(1000).default(""),
  nodes: z.array(diagramNodeSchema).min(1).max(60),
  edges: z.array(diagramEdgeSchema).max(120).default([]),
});
export type Diagram = z.infer<typeof diagramSchema>;
export type DiagramNode = z.infer<typeof diagramNodeSchema>;

export const reviewGroupSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(160),
  why: z.string().min(1).max(1200),
  kind: z.enum(["core", "supporting", "tests", "noise"]),
  hunkIds: z.array(z.string()).min(1),
});
export type ReviewGroup = z.infer<typeof reviewGroupSchema>;

export const analysisResultSchema = z.object({
  summary: z.string().min(1).max(4000),
  ticket: z
    .object({
      url: z.string().nullable(),
      title: z.string().nullable(),
      projectTitle: z.string().nullable().default(null),
    })
    .default({ url: null, title: null, projectTitle: null }),
  // Ordered as a reading path: foundations first, consumers later, noise last.
  groups: z.array(reviewGroupSchema).min(1).max(40),
  narrative: z
    .array(
      z.object({
        title: z.string().min(1).max(160),
        body: z.string().min(1).max(4000),
        groupIds: z.array(z.string()).default([]),
      }),
    )
    .min(1)
    .max(20),
  lookClosely: z
    .array(
      z.object({
        title: z.string().min(1).max(160),
        reason: z.string().min(1).max(1200),
        severity: z.enum(["high", "medium", "low"]),
        groupIds: z.array(z.string()).default([]),
      }),
    )
    .max(12)
    .default([]),
  diagrams: z.array(diagramSchema).min(1).max(3),
});
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

// ---- Pull request as the app sees it ---------------------------------------

export const hunkSchema = z.object({
  id: z.string(),
  /** Content hash that survives new commits; viewed state is keyed on it. */
  fingerprint: z.string(),
  fileIndex: z.number(),
  header: z.string(),
  /** Patch text for this hunk only, starting at its `@@` line. */
  patch: z.string(),
  additions: z.number(),
  deletions: z.number(),
});
export type Hunk = z.infer<typeof hunkSchema>;

export const prFileSchema = z.object({
  index: z.number(),
  path: z.string(),
  previousPath: z.string().nullable(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
  /** False for binary or oversized files GitHub returns without a patch. */
  hasPatch: z.boolean(),
  hunkIds: z.array(z.string()),
});
export type PrFile = z.infer<typeof prFileSchema>;

export const reviewThreadCommentSchema = z.object({
  id: z.string(),
  databaseId: z.number(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string(),
});

export const reviewThreadSchema = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number().nullable(),
  startLine: z.number().nullable(),
  side: z.enum(["LEFT", "RIGHT"]),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  comments: z.array(reviewThreadCommentSchema),
});
export type ReviewThread = z.infer<typeof reviewThreadSchema>;

export const prDetailsSchema = z.object({
  ref: prRefSchema,
  url: z.string(),
  title: z.string(),
  body: z.string(),
  author: z.string(),
  state: z.string(),
  draft: z.boolean(),
  headSha: z.string(),
  headRef: z.string(),
  baseRef: z.string(),
  viewer: z.string(),
  isOwnPr: z.boolean(),
  files: z.array(prFileSchema),
  hunks: z.array(hunkSchema),
  threads: z.array(reviewThreadSchema),
});
export type PrDetails = z.infer<typeof prDetailsSchema>;

// ---- Analysis records -------------------------------------------------------

export const analysisRecordSchema = z.object({
  id: z.string(),
  ref: prRefSchema,
  headSha: z.string(),
  status: z.enum(["running", "done", "failed"]),
  error: z.string().nullable(),
  result: analysisResultSchema.nullable(),
  workerThreadId: z.string().nullable(),
  diffOnly: z.boolean(),
  ticketUrl: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type AnalysisRecord = z.infer<typeof analysisRecordSchema>;

// ---- Comments ----------------------------------------------------------------

export const diffSideSchema = z.enum(["LEFT", "RIGHT"]);
export type DiffSide = z.infer<typeof diffSideSchema>;

export const draftCommentSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  side: diffSideSchema,
  startLine: z.number().int().positive().nullable(),
  startSide: diffSideSchema.nullable(),
  body: z.string().trim().min(1).max(65000),
});
export type DraftComment = z.infer<typeof draftCommentSchema>;

export const pendingCommentSchema = draftCommentSchema.extend({
  id: z.string(),
  createdAt: z.string(),
});
export type PendingComment = z.infer<typeof pendingCommentSchema>;

export const storedCommentSchema = z.object({
  id: z.string(),
  source: z.enum(["diff", "diagram"]),
  ref: prRefSchema,
  headSha: z.string(),
  body: z.string(),
  tag: commentTagSchema.nullable(),
  status: z.enum(["open", "resolved", "outdated"]),
  // Diff comments
  githubCommentId: z.number().nullable(),
  githubUrl: z.string().nullable(),
  path: z.string().nullable(),
  line: z.number().nullable(),
  // Diagram comments
  analysisId: z.string().nullable(),
  diagramId: z.string().nullable(),
  nodeId: z.string().nullable(),
  nodeLabel: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StoredComment = z.infer<typeof storedCommentSchema>;

export const modelSelectionSchema = z.object({
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: z.string(),
  serviceTier: z.string().optional(),
});
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

export const reviewSummarySchema = z.object({
  ref: prRefSchema,
  title: z.string(),
  url: z.string(),
  lastOpenedAt: z.string(),
  analysisStatus: z.enum(["none", "running", "done", "failed"]),
});
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;
