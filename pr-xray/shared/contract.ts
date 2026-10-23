// The app <-> server RPC contract. The app imports it as a type only.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  analysisRecordSchema,
  commentTagSchema,
  draftCommentSchema,
  modelSelectionSchema,
  pendingCommentSchema,
  prDetailsSchema,
  prRefSchema,
  reviewSummarySchema,
  storedCommentSchema,
} from "./schema";

export const reviewGetOutputSchema = z.object({
  pr: prDetailsSchema,
  /** Analysis for the current head commit, if any. */
  current: analysisRecordSchema.nullable(),
  /** Latest completed analysis, possibly for an older head commit. */
  completed: analysisRecordSchema.nullable(),
  viewedGroups: z.array(z.string()),
  pending: z.array(pendingCommentSchema),
  comments: z.array(storedCommentSchema),
  ticketUrl: z.string().nullable(),
  ticketOverridden: z.boolean(),
});
export type ReviewGet = z.infer<typeof reviewGetOutputSchema>;

const ok = z.object({ ok: z.boolean() });
const threadOut = z.object({ threadId: z.string() });

export const rpcContract = defineRpcContract({
  "review.get": {
    input: z.object({ ref: prRefSchema }),
    output: reviewGetOutputSchema,
  },
  "review.recent": {
    input: z.null(),
    output: z.object({ reviews: z.array(reviewSummarySchema) }),
  },
  "review.setTicket": {
    input: z.object({ ref: prRefSchema, url: z.string().url().nullable() }),
    output: ok,
  },
  "analysis.start": {
    input: z.object({ ref: prRefSchema }),
    output: z.object({ analysis: analysisRecordSchema }),
  },
  "group.setViewed": {
    input: z.object({ analysisId: z.string(), groupId: z.string(), viewed: z.boolean() }),
    output: ok,
  },
  "file.contents": {
    input: z.object({ ref: prRefSchema, path: z.string(), previousPath: z.string().nullable() }),
    output: z.object({ old: z.string().nullable(), new: z.string().nullable() }),
  },
  "comment.single": {
    input: z.object({ ref: prRefSchema, draft: draftCommentSchema }),
    output: ok,
  },
  "comment.pendingAdd": {
    input: z.object({ ref: prRefSchema, draft: draftCommentSchema }),
    output: pendingCommentSchema,
  },
  "comment.pendingUpdate": {
    input: z.object({ ref: prRefSchema, id: z.string(), body: z.string().trim().min(1) }),
    output: ok,
  },
  "comment.pendingRemove": {
    input: z.object({ ref: prRefSchema, id: z.string() }),
    output: ok,
  },
  "review.submit": {
    input: z.object({
      ref: prRefSchema,
      event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
      body: z.string(),
    }),
    output: z.object({ posted: z.number() }),
  },
  "thread.reply": {
    input: z.object({ ref: prRefSchema, commentDatabaseId: z.number(), body: z.string().trim().min(1) }),
    output: ok,
  },
  "thread.resolve": {
    input: z.object({
      ref: prRefSchema,
      threadId: z.string(),
      resolved: z.boolean(),
      commentDatabaseIds: z.array(z.number()),
    }),
    output: ok,
  },
  "comment.setTag": {
    input: z.object({ commentId: z.string(), tag: commentTagSchema }),
    output: ok,
  },
  "diagram.addComment": {
    input: z.object({
      ref: prRefSchema,
      analysisId: z.string(),
      diagramId: z.string(),
      nodeId: z.string(),
      body: z.string().trim().min(1).max(10000),
    }),
    output: storedCommentSchema,
  },
  "diagram.updateComment": {
    input: z.object({
      id: z.string(),
      body: z.string().trim().min(1).max(10000).optional(),
      status: z.enum(["open", "resolved"]).optional(),
    }),
    output: ok,
  },
  "diagram.deleteComment": {
    input: z.object({ id: z.string() }),
    output: ok,
  },
  "fix.thread": {
    input: z.object({ ref: prRefSchema, threadId: z.string() }),
    output: threadOut,
  },
  "fix.allDiff": {
    input: z.object({ ref: prRefSchema }),
    output: threadOut,
  },
  "fix.allDiagram": {
    input: z.object({ ref: prRefSchema }),
    output: threadOut,
  },
  "settings.get": {
    input: z.null(),
    output: z.object({
      identity: z.object({ login: z.string(), source: z.enum(["token", "gh"]) }).nullable(),
      identityError: z.string().nullable(),
      model: modelSelectionSchema.nullable(),
      recommended: modelSelectionSchema.nullable(),
    }),
  },
  "settings.setModel": {
    input: z.object({ selection: modelSelectionSchema.nullable() }),
    output: ok,
  },
});
