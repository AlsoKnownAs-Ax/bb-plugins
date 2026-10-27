// GitHub-style comment UI: threads, the composer, pending drafts and tags.
import { useState, type KeyboardEvent } from "react";
import { experimental_VoiceInputTextarea as VoiceInputTextarea, Markdown, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { TEXTAREA_CLASS } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { COMMENT_TAGS } from "../shared/tags";
import type {
  CommentTag,
  PendingComment,
  PrRef,
  ReviewThread,
  StoredComment,
} from "../shared/schema";
import { errorMessage, type Rpc } from "./useReview";

const MARKER = /\n*<!-- pr-xray: tag=[a-z-]+ -->\s*$/u;

export function TagChip({
  tag,
  onChange,
  className,
}: {
  tag: CommentTag | null;
  onChange?: (tag: CommentTag) => void;
  className?: string;
}) {
  const chip = (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground",
        onChange && "cursor-pointer hover:bg-state-hover hover:text-foreground",
        className,
      )}
    >
      {tag ?? "tagging…"}
    </span>
  );
  if (!onChange) return chip;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Change tag">
          {chip}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {COMMENT_TAGS.map((candidate) => (
          <DropdownMenuItem key={candidate} onSelect={() => onChange(candidate)}>
            {candidate === tag ? <Icon name="Check" className="size-3.5" /> : <span className="size-3.5" />}
            {candidate}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Composer({
  placeholder,
  initial = "",
  suggestion,
  autoFocus = true,
  actions,
  onCancel,
}: {
  placeholder: string;
  initial?: string;
  /** Lines to seed a ```suggestion block with. */
  suggestion?: string[] | null;
  autoFocus?: boolean;
  actions: { label: string; primary?: boolean; run: (body: string) => Promise<void> }[];
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [dictating, setDictating] = useState(false);
  const submit = async (run: (body: string) => Promise<void>) => {
    if (body.trim() === "" || busy || dictating) return;
    setBusy(true);
    try {
      await run(body);
      setBody("");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      const primary = actions.find((action) => action.primary) ?? actions[0];
      if (primary) void submit(primary.run);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel?.();
    }
  };
  return (
    <div className="space-y-2 rounded-md border border-border bg-card p-2">
      <VoiceInputTextarea
        value={body}
        onValueChange={setBody}
        onVoiceInputActiveChange={setDictating}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className={cn(TEXTAREA_CLASS, "min-h-20 text-sm")}
      />
      <div className="flex flex-wrap items-center gap-2">
        {suggestion ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setBody((current) => `${current}${current ? "\n" : ""}\`\`\`suggestion\n${suggestion.join("\n")}\n\`\`\``)}
          >
            <Icon name="FileDiff" />
            Suggest change
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {onCancel ? (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          ) : null}
          {actions.map((action) => (
            <Button
              key={action.label}
              type="button"
              size="sm"
              variant={action.primary ? "default" : "outline"}
              disabled={busy || dictating || body.trim() === ""}
              onClick={() => void submit(action.run)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ThreadView({
  rpc,
  prRef,
  thread,
  viewer,
  storedByGithubId,
}: {
  rpc: Rpc;
  prRef: PrRef;
  thread: ReviewThread;
  viewer: string;
  storedByGithubId: Map<number, StoredComment>;
}) {
  const navigate = useBbNavigate();
  const settled = thread.isOutdated || thread.isResolved;
  const [collapsed, setCollapsed] = useState(settled);
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const first = thread.comments[0];
  const mine = thread.comments.some((comment) => comment.author.toLowerCase() === viewer.toLowerCase());

  const resolve = async () => {
    setBusy(true);
    try {
      await rpc.call("thread.resolve", {
        ref: prRef,
        threadId: thread.id,
        resolved: !thread.isResolved,
        commentDatabaseIds: thread.comments.map((comment) => comment.databaseId),
      });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const fix = async () => {
    setBusy(true);
    try {
      const { threadId } = await rpc.call("fix.thread", { ref: prRef, threadId: thread.id });
      // Stay on the review; the fix runs in the background.
      toast.success("Started a fix thread", { action: { label: "Open", onClick: () => navigate.toThread(threadId) } });
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        "my-2 max-w-3xl overflow-hidden rounded-lg border border-l-4 font-sans text-sm shadow-xs",
        settled ? "border-border border-l-muted-foreground/40 bg-card" : "border-warning/60 border-l-warning bg-warning/10",
      )}
    >
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-state-hover",
          !collapsed && "border-b",
          settled ? "border-border text-muted-foreground" : "border-warning/40 text-foreground",
        )}
      >
        <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} className="size-3.5" />
        {settled ? null : <Icon name="MessageSquare" className="size-3.5 shrink-0 text-warning-text" />}
        <span className="shrink-0 font-medium text-foreground">{first?.author ?? "comment"}</span>
        <span className={cn("min-w-0 truncate", settled && "text-muted-foreground")}>{first?.body.replace(MARKER, "").split("\n")[0]}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {thread.isOutdated ? <span className="rounded border border-border px-1.5">outdated</span> : null}
          {thread.isResolved ? <span className="rounded border border-border px-1.5">resolved</span> : null}
          <span>{thread.comments.length}</span>
          <Icon name="MessageSquare" className="size-3.5" />
        </span>
      </button>
      {collapsed ? null : (
        <div className="space-y-3 px-3 py-3">
          {thread.comments.map((comment) => {
            const stored = storedByGithubId.get(comment.databaseId);
            return (
              <div key={comment.id} className="space-y-1">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{comment.author}</span>
                  <a href={comment.url} target="_blank" rel="noreferrer" className="hover:underline">
                    {new Date(comment.createdAt).toLocaleString()}
                  </a>
                  {stored ? (
                    <TagChip
                      tag={stored.tag}
                      onChange={(tag) => {
                        rpc.call("comment.setTag", { commentId: stored.id, tag }).catch((error: unknown) =>
                          toast.error(errorMessage(error)),
                        );
                      }}
                    />
                  ) : null}
                </div>
                <Markdown content={comment.body.replace(MARKER, "")} className="text-sm" />
              </div>
            );
          })}
          {replying ? (
            <Composer
              placeholder="Reply…"
              onCancel={() => setReplying(false)}
              actions={[
                {
                  label: "Reply",
                  primary: true,
                  run: async (body) => {
                    await rpc.call("thread.reply", { ref: prRef, commentDatabaseId: first!.databaseId, body });
                    setReplying(false);
                  },
                },
              ]}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setReplying(true)}>
                Reply
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void resolve()} disabled={busy}>
                {thread.isResolved ? "Unresolve" : "Resolve"}
              </Button>
              {mine && !thread.isResolved ? (
                <Button size="sm" variant="ghost" onClick={() => void fix()} disabled={busy}>
                  <Icon name="Bot" />
                  Fix with agent
                </Button>
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function PendingView({ rpc, prRef, comment }: { rpc: Rpc; prRef: PrRef; comment: PendingComment }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <div className="my-2 max-w-3xl font-sans">
        <Composer
          placeholder="Edit pending comment"
          initial={comment.body}
          onCancel={() => setEditing(false)}
          actions={[
            {
              label: "Save",
              primary: true,
              run: async (body) => {
                await rpc.call("comment.pendingUpdate", { ref: prRef, id: comment.id, body });
                setEditing(false);
              },
            },
          ]}
        />
      </div>
    );
  }
  return (
    <div className="my-2 max-w-3xl rounded-lg border border-l-4 border-warning/50 border-l-warning bg-warning/5 px-3 py-2 font-sans text-sm">
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded border border-warning/70 px-1.5 font-medium text-warning-text">pending</span>
        <span>Part of your review; posted when you submit.</span>
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              rpc.call("comment.pendingRemove", { ref: prRef, id: comment.id }).catch((error: unknown) =>
                toast.error(errorMessage(error)),
              );
            }}
          >
            Delete
          </Button>
        </span>
      </div>
      <Markdown content={comment.body} className="text-sm" />
    </div>
  );
}
