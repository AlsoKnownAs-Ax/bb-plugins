// The grouped diff: a reading-path sidebar and hunk diffs with GitHub-style
// inline comments.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import {
  experimental_SourceCode as SourceCode,
  experimental_useCodeTheme as useCodeTheme,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { DraftComment, Hunk, PendingComment, PrFile, ReviewGroup, ReviewThread, StoredComment } from "../shared/schema";
import { Composer, PendingView, ThreadView } from "./comments";
import { filePatch, firstChangedLine, lineInHunks, newSideLines, threadVisibleIn } from "./diff-utils";
import { errorMessage, type ReviewGet, type Rpc } from "./useReview";

export type ViewMode = "unified" | "split";

interface DraftTarget {
  hunkId: string;
  path: string;
  range: SelectedLineRange;
}

type AnnotationItem =
  | { kind: "thread"; thread: ReviewThread }
  | { kind: "pending"; comment: PendingComment }
  | { kind: "draft"; draft: DraftTarget };

const KIND_LABEL: Record<ReviewGroup["kind"], string> = {
  core: "Core",
  supporting: "Supporting",
  tests: "Tests",
  noise: "Noise",
};

const toSide = (side: SelectedLineRange["side"]): "LEFT" | "RIGHT" => (side === "deletions" ? "LEFT" : "RIGHT");
const toAnnotationSide = (side: "LEFT" | "RIGHT") => (side === "LEFT" ? "deletions" : "additions");

/** Groups from the analysis, or one group per file while it is not ready. */
export function displayGroups(data: ReviewGet): ReviewGroup[] {
  const result = data.completed?.result;
  if (result && data.completed?.headSha === data.pr.headSha) return result.groups;
  if (result) {
    // Older analysis: keep its groups for hunks that still exist, add the rest per file.
    const known = new Set(data.pr.hunks.map((hunk) => hunk.id));
    const groups = result.groups
      .map((group) => ({ ...group, hunkIds: group.hunkIds.filter((id) => known.has(id)) }))
      .filter((group) => group.hunkIds.length > 0);
    const covered = new Set(groups.flatMap((group) => group.hunkIds));
    const rest = data.pr.hunks.filter((hunk) => !covered.has(hunk.id)).map((hunk) => hunk.id);
    if (rest.length > 0) {
      groups.push({ id: "__new", title: "Changed since the analysis", why: "Hunks the last analysis did not see.", kind: "core", hunkIds: rest });
    }
    return groups;
  }
  return data.pr.files
    .filter((file) => file.hunkIds.length > 0)
    .map((file) => ({
      id: `file-${file.index}`,
      title: file.path,
      why: "Analysis not ready yet; showing the diff by file.",
      kind: "core" as const,
      hunkIds: file.hunkIds,
    }));
}

export function DiffTab({
  data,
  rpc,
  view,
  groups,
  viewed,
  onToggleViewed,
  activeGroupId,
  onActiveGroupChange,
  scrollRequest,
  onShowInDiagram,
}: {
  data: ReviewGet;
  rpc: Rpc;
  view: ViewMode;
  groups: ReviewGroup[];
  viewed: Set<string>;
  onToggleViewed: (groupId: string, viewed: boolean) => void;
  activeGroupId: string | null;
  onActiveGroupChange: (groupId: string) => void;
  scrollRequest: { groupId: string; nonce: number } | null;
  onShowInDiagram: ((groupId: string) => void) | null;
}) {
  const { pr } = data;
  const navigate = useBbNavigate();
  const hunks = useMemo(() => new Map(pr.hunks.map((hunk) => [hunk.id, hunk])), [pr.hunks]);
  const files = useMemo(() => new Map(pr.files.map((file) => [file.index, file])), [pr.files]);
  const storedByGithubId = useMemo(() => {
    const map = new Map<number, StoredComment>();
    for (const comment of data.comments) if (comment.githubCommentId !== null) map.set(comment.githubCommentId, comment);
    return map;
  }, [data.comments]);
  const [draft, setDraft] = useState<DraftTarget | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [fullFile, setFullFile] = useState<{ file: PrFile; content: string | null; loading: boolean } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hunkOrder = useMemo(() => groups.flatMap((group) => group.hunkIds), [groups]);
  const [activeHunk, setActiveHunk] = useState<string | null>(null);

  const scrollTo = useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  useEffect(() => {
    if (scrollRequest) scrollTo(`group-${scrollRequest.groupId}`);
  }, [scrollRequest, scrollTo]);

  // Track which group is on screen for the sidebar highlight.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const id = visible?.target.getAttribute("data-group-id");
        if (id) onActiveGroupChange(id);
      },
      { root, rootMargin: "0px 0px -70% 0px" },
    );
    root.querySelectorAll("[data-group-id]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [groups, onActiveGroupChange]);

  // Keyboard: j/k hunks, n/p groups, c comment on the current hunk.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.closest("input, textarea, [contenteditable=true]") || event.metaKey || event.ctrlKey || event.altKey)) return;
      if (event.key === "j" || event.key === "k") {
        const index = activeHunk ? hunkOrder.indexOf(activeHunk) : -1;
        const next = hunkOrder[Math.max(0, Math.min(hunkOrder.length - 1, index + (event.key === "j" ? 1 : -1)))];
        if (next) {
          setActiveHunk(next);
          scrollTo(`hunk-${next}`);
          event.preventDefault();
        }
      } else if (event.key === "n" || event.key === "p") {
        const index = groups.findIndex((group) => group.id === activeGroupId);
        const next = groups[Math.max(0, Math.min(groups.length - 1, index + (event.key === "n" ? 1 : -1)))];
        if (next) {
          scrollTo(`group-${next.id}`);
          setActiveHunk(next.hunkIds[0] ?? null);
          event.preventDefault();
        }
      } else if (event.key === "c") {
        const hunk = hunks.get(activeHunk ?? groups.find((group) => group.id === activeGroupId)?.hunkIds[0] ?? "");
        const file = hunk ? files.get(hunk.fileIndex) : undefined;
        if (hunk && file) {
          const at = firstChangedLine(hunk);
          setDraft({ hunkId: hunk.id, path: file.path, range: { start: at.line, end: at.line, side: toAnnotationSide(at.side) } });
          event.preventDefault();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeHunk, activeGroupId, files, groups, hunkOrder, hunks, scrollTo]);

  const anchoredThreadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const thread of pr.threads) {
      const file = pr.files.find((candidate) => candidate.path === thread.path);
      if (!file) continue;
      const fileHunks = file.hunkIds.map((id) => hunks.get(id)!).filter(Boolean);
      if (threadVisibleIn(thread, file.path, fileHunks)) ids.add(thread.id);
    }
    return ids;
  }, [hunks, pr.files, pr.threads]);
  const otherThreads = pr.threads.filter((thread) => !anchoredThreadIds.has(thread.id));

  const draftToComment = (target: DraftTarget, body: string): DraftComment => {
    const side = toSide(target.range.endSide ?? target.range.side);
    const start = Math.min(target.range.start, target.range.end);
    const end = Math.max(target.range.start, target.range.end);
    return {
      path: target.path,
      line: end,
      side,
      startLine: start === end ? null : start,
      startSide: start === end ? null : toSide(target.range.side),
      body,
    };
  };

  const openFullFile = async (file: PrFile) => {
    setFullFile({ file, content: null, loading: true });
    try {
      const contents = await rpc.call("file.contents", { ref: pr.ref, path: file.path, previousPath: file.previousPath });
      setFullFile({ file, content: contents.new ?? contents.old, loading: false });
    } catch (error) {
      toast.error(errorMessage(error));
      setFullFile(null);
    }
  };

  const fixAll = async () => {
    try {
      const { threadId } = await rpc.call("fix.allDiff", { ref: pr.ref });
      toast.success("Started a thread to fix your open comments");
      navigate.toThread(threadId);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const viewedCount = groups.filter((group) => viewed.has(group.id)).length;
  const myOpenThreads = pr.threads.filter(
    (thread) => !thread.isResolved && thread.comments.some((comment) => comment.author.toLowerCase() === pr.viewer.toLowerCase()),
  ).length;

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border">
        <div className="space-y-2 border-b border-border p-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Reading path</span>
            <span>
              {viewedCount}/{groups.length} viewed
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-foreground/70 transition-all" style={{ width: `${groups.length ? (viewedCount / groups.length) * 100 : 0}%` }} />
          </div>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto p-2">
          {groups.map((group, index) => (
            <div
              key={group.id}
              className={cn(
                "group flex items-start gap-2 rounded-md px-2 py-1.5 text-sm",
                activeGroupId === group.id ? "bg-state-active" : "hover:bg-state-hover",
              )}
            >
              <Checkbox
                className="mt-0.5"
                checked={viewed.has(group.id)}
                onCheckedChange={(checked) => onToggleViewed(group.id, checked === true)}
                aria-label={`Mark "${group.title}" viewed`}
              />
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => scrollTo(`group-${group.id}`)}>
                <div className={cn("truncate", viewed.has(group.id) && "text-muted-foreground")}>
                  <span className="mr-1 text-muted-foreground">{index + 1}.</span>
                  {group.title}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {KIND_LABEL[group.kind]} · {group.hunkIds.length} hunk{group.hunkIds.length === 1 ? "" : "s"}
                </div>
              </button>
            </div>
          ))}
          {otherThreads.length > 0 ? (
            <button
              type="button"
              className="mt-2 w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-state-hover"
              onClick={() => scrollTo("other-threads")}
            >
              {otherThreads.length} conversation{otherThreads.length === 1 ? "" : "s"} outside the diff
            </button>
          ) : null}
        </nav>
        <div className="space-y-2 border-t border-border p-3">
          <Button className="w-full" size="sm" onClick={() => setSubmitOpen(true)}>
            <Icon name="Sent" />
            {data.pending.length > 0 ? `Submit review (${data.pending.length})` : "Submit review"}
          </Button>
          <Button className="w-full" size="sm" variant="outline" disabled={myOpenThreads === 0} onClick={() => void fixAll()}>
            <Icon name="Bot" />
            Fix all open comments{myOpenThreads ? ` (${myOpenThreads})` : ""}
          </Button>
          <p className="text-[11px] text-muted-foreground">j/k hunks · n/p groups · c comment</p>
        </div>
      </aside>

      <div ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1400px] space-y-8 p-4 md:p-6">
          {groups.map((group, index) => (
            <section key={group.id} id={`group-${group.id}`} data-group-id={group.id} className="scroll-mt-4 space-y-3">
              <header className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{index + 1}</span>
                  <h2 className="text-base font-semibold">{group.title}</h2>
                  <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{KIND_LABEL[group.kind]}</span>
                  <div className="ml-auto flex items-center gap-2">
                    {onShowInDiagram ? (
                      <Button size="sm" variant="ghost" onClick={() => onShowInDiagram(group.id)}>
                        <Icon name="Workflow" />
                        Show in diagram
                      </Button>
                    ) : null}
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Checkbox checked={viewed.has(group.id)} onCheckedChange={(checked) => onToggleViewed(group.id, checked === true)} />
                      Viewed
                    </label>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">{group.why}</p>
              </header>
              {viewed.has(group.id) ? null : (
                <GroupHunks
                  group={group}
                  hunks={hunks}
                  files={files}
                  data={data}
                  rpc={rpc}
                  view={view}
                  draft={draft}
                  setDraft={setDraft}
                  activeHunk={activeHunk}
                  setActiveHunk={setActiveHunk}
                  storedByGithubId={storedByGithubId}
                  draftToComment={draftToComment}
                  openFullFile={(file) => void openFullFile(file)}
                />
              )}
            </section>
          ))}
          {otherThreads.length > 0 ? (
            <section id="other-threads" className="space-y-2">
              <h2 className="text-base font-semibold">Conversations outside the diff</h2>
              <p className="text-sm text-muted-foreground">Outdated threads or comments on lines the diff no longer shows.</p>
              {otherThreads.map((thread) => (
                <div key={thread.id}>
                  <div className="font-mono text-xs text-muted-foreground">
                    {thread.path}:{thread.line ?? "?"}
                  </div>
                  <ThreadView rpc={rpc} prRef={pr.ref} thread={thread} viewer={pr.viewer} storedByGithubId={storedByGithubId} />
                </div>
              ))}
            </section>
          ) : null}
        </div>
      </div>

      <SubmitReviewDialog open={submitOpen} onOpenChange={setSubmitOpen} data={data} rpc={rpc} />
      <Dialog open={fullFile !== null} onOpenChange={(open) => !open && setFullFile(null)}>
        <DialogContent className="max-h-[85vh] max-w-5xl overflow-hidden">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{fullFile?.file.path}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-auto">
            {fullFile?.loading ? (
              <p className="p-4 text-sm text-muted-foreground">Loading…</p>
            ) : fullFile?.content != null ? (
              <SourceCode content={fullFile.content} path={fullFile.file.path} />
            ) : (
              <p className="p-4 text-sm text-muted-foreground">No text content for this file.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function GroupHunks({
  group,
  hunks,
  files,
  data,
  rpc,
  view,
  draft,
  setDraft,
  activeHunk,
  setActiveHunk,
  storedByGithubId,
  draftToComment,
  openFullFile,
}: {
  group: ReviewGroup;
  hunks: Map<string, Hunk>;
  files: Map<number, PrFile>;
  data: ReviewGet;
  rpc: Rpc;
  view: ViewMode;
  draft: DraftTarget | null;
  setDraft: (draft: DraftTarget | null) => void;
  activeHunk: string | null;
  setActiveHunk: (id: string) => void;
  storedByGithubId: Map<number, StoredComment>;
  draftToComment: (target: DraftTarget, body: string) => DraftComment;
  openFullFile: (file: PrFile) => void;
}) {
  // Hunks of this group, kept together per file in diff order.
  const byFile = new Map<number, Hunk[]>();
  for (const id of group.hunkIds) {
    const hunk = hunks.get(id);
    if (!hunk) continue;
    byFile.set(hunk.fileIndex, [...(byFile.get(hunk.fileIndex) ?? []), hunk]);
  }
  return (
    <div className="space-y-4">
      {[...byFile.entries()].map(([fileIndex, fileHunks]) => {
        const file = files.get(fileIndex)!;
        return (
          <div key={fileIndex} className="overflow-hidden rounded-lg border border-border">
            <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs">
              <Icon name="Code" className="size-3.5 text-muted-foreground" />
              <span className="truncate font-mono">
                {file.previousPath ? `${file.previousPath} → ` : ""}
                {file.path}
              </span>
              <span className="text-muted-foreground">
                <span className="text-success">+{file.additions}</span> <span className="text-destructive">-{file.deletions}</span>
              </span>
              <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-xs" onClick={() => openFullFile(file)}>
                Full file
              </Button>
            </div>
            {fileHunks
              .sort((a, b) => file.hunkIds.indexOf(a.id) - file.hunkIds.indexOf(b.id))
              .map((hunk) => (
                <HunkDiff
                  key={hunk.id}
                  hunk={hunk}
                  file={file}
                  data={data}
                  rpc={rpc}
                  view={view}
                  draft={draft?.hunkId === hunk.id ? draft : null}
                  setDraft={setDraft}
                  active={activeHunk === hunk.id}
                  onActivate={() => setActiveHunk(hunk.id)}
                  storedByGithubId={storedByGithubId}
                  draftToComment={draftToComment}
                />
              ))}
          </div>
        );
      })}
    </div>
  );
}

function HunkDiff({
  hunk,
  file,
  data,
  rpc,
  view,
  draft,
  setDraft,
  active,
  onActivate,
  storedByGithubId,
  draftToComment,
}: {
  hunk: Hunk;
  file: PrFile;
  data: ReviewGet;
  rpc: Rpc;
  view: ViewMode;
  draft: DraftTarget | null;
  setDraft: (draft: DraftTarget | null) => void;
  active: boolean;
  onActivate: () => void;
  storedByGithubId: Map<number, StoredComment>;
  draftToComment: (target: DraftTarget, body: string) => DraftComment;
}) {
  const { pr } = data;
  const codeTheme = useCodeTheme();
  const [selection, setSelection] = useState<SelectedLineRange | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const patch = useMemo(() => filePatch(file, [hunk]), [file, hunk]);

  const annotations = useMemo(() => {
    const byLine = new Map<string, { side: "LEFT" | "RIGHT"; line: number; items: AnnotationItem[] }>();
    const add = (side: "LEFT" | "RIGHT", line: number, item: AnnotationItem) => {
      const key = `${side}:${line}`;
      const entry = byLine.get(key) ?? { side, line, items: [] };
      entry.items.push(item);
      byLine.set(key, entry);
    };
    for (const thread of pr.threads) {
      if (threadVisibleIn(thread, file.path, [hunk])) add(thread.side, thread.line!, { kind: "thread", thread });
    }
    for (const comment of data.pending) {
      if (comment.path === file.path && lineInHunks([hunk], comment.side, comment.line)) add(comment.side, comment.line, { kind: "pending", comment });
    }
    if (draft) {
      const side = toSide(draft.range.endSide ?? draft.range.side);
      add(side, Math.max(draft.range.start, draft.range.end), { kind: "draft", draft });
    }
    return [...byLine.values()].map(
      (entry): DiffLineAnnotation<AnnotationItem[]> => ({
        side: toAnnotationSide(entry.side),
        lineNumber: entry.line,
        metadata: entry.items,
      }),
    );
  }, [data.pending, draft, file.path, hunk, pr.threads]);

  const options = useMemo(
    () => ({
      diffStyle: view,
      overflow: "wrap" as const,
      disableFileHeader: true,
      themeType: codeTheme.mode,
      theme: codeTheme.name as never,
      enableGutterUtility: true,
      enableLineSelection: true,
      lineHoverHighlight: "number" as const,
      onLineSelected: (range: SelectedLineRange | null) => setSelection(range),
      onGutterUtilityClick: (range: SelectedLineRange) => {
        const current = selectionRef.current;
        const useSelection =
          current !== null && range.start >= Math.min(current.start, current.end) && range.start <= Math.max(current.start, current.end);
        setDraft({ hunkId: hunk.id, path: file.path, range: useSelection ? current : range });
      },
    }),
    [codeTheme.mode, codeTheme.name, file.path, hunk.id, setDraft, view],
  );

  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<AnnotationItem[]>) => (
      <div className="px-3 py-1">
        {annotation.metadata.map((item) => {
          if (item.kind === "thread") {
            return (
              <ThreadView key={item.thread.id} rpc={rpc} prRef={pr.ref} thread={item.thread} viewer={pr.viewer} storedByGithubId={storedByGithubId} />
            );
          }
          if (item.kind === "pending") return <PendingView key={item.comment.id} rpc={rpc} prRef={pr.ref} comment={item.comment} />;
          const start = Math.min(item.draft.range.start, item.draft.range.end);
          const end = Math.max(item.draft.range.start, item.draft.range.end);
          const isNewSide = toSide(item.draft.range.endSide ?? item.draft.range.side) === "RIGHT";
          return (
            <div key="draft" className="my-2 max-w-3xl font-sans">
              <div className="mb-1 text-xs text-muted-foreground">
                Comment on {start === end ? `line ${end}` : `lines ${start}–${end}`}
              </div>
              <Composer
                placeholder="Leave a comment (⌘↩ to add to your review)"
                suggestion={isNewSide ? newSideLines([hunk], start, end) : null}
                onCancel={() => setDraft(null)}
                actions={[
                  {
                    label: "Add single comment",
                    run: async (body) => {
                      await rpc.call("comment.single", { ref: pr.ref, draft: draftToComment(item.draft, body) });
                      setDraft(null);
                      toast.success("Comment posted to GitHub");
                    },
                  },
                  {
                    label: data.pending.length > 0 ? "Add to review" : "Start a review",
                    primary: true,
                    run: async (body) => {
                      await rpc.call("comment.pendingAdd", { ref: pr.ref, draft: draftToComment(item.draft, body) });
                      setDraft(null);
                    },
                  },
                ]}
              />
            </div>
          );
        })}
      </div>
    ),
    [data.pending.length, draftToComment, hunk, pr.ref, pr.viewer, rpc, setDraft, storedByGithubId],
  );

  return (
    <div
      id={`hunk-${hunk.id}`}
      onPointerDown={onActivate}
      className={cn("scroll-mt-4 border-b border-border last:border-b-0", active && "ring-1 ring-inset ring-ring")}
      style={{ "--diffs-font-size": "12px", "--diffs-line-height": "18px" } as React.CSSProperties}
    >
      <PatchDiff<AnnotationItem[]>
        patch={patch}
        options={options}
        lineAnnotations={annotations}
        selectedLines={selection}
        renderAnnotation={renderAnnotation}
      />
    </div>
  );
}

function SubmitReviewDialog({
  open,
  onOpenChange,
  data,
  rpc,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: ReviewGet;
  rpc: Rpc;
}) {
  const [body, setBody] = useState("");
  const [event, setEvent] = useState<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">("COMMENT");
  const [busy, setBusy] = useState(false);
  const own = data.pr.isOwnPr;
  const submit = async () => {
    setBusy(true);
    try {
      const { posted } = await rpc.call("review.submit", { ref: data.pr.ref, event: own ? "COMMENT" : event, body });
      toast.success(`Review submitted with ${posted} comment${posted === 1 ? "" : "s"}`);
      setBody("");
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const options = [
    { value: "COMMENT" as const, label: "Comment", hint: "General feedback without explicit approval." },
    { value: "APPROVE" as const, label: "Approve", hint: "Approve merging these changes." },
    { value: "REQUEST_CHANGES" as const, label: "Request changes", hint: "Feedback that must be addressed before merging." },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Submit review</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {data.pending.length} pending comment{data.pending.length === 1 ? "" : "s"} will be posted to GitHub.
        </p>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Leave a summary (optional)" className="min-h-24" />
        <div className="space-y-1.5">
          {options.map((option) => {
            const disabled = own && option.value !== "COMMENT";
            return (
              <label key={option.value} className={cn("flex items-start gap-2 text-sm", disabled && "opacity-50")}>
                <input
                  type="radio"
                  name="review-event"
                  className="mt-1"
                  disabled={disabled}
                  checked={(own ? "COMMENT" : event) === option.value}
                  onChange={() => setEvent(option.value)}
                />
                <span>
                  <span className="font-medium">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {disabled ? "GitHub doesn't allow this on your own pull request." : option.hint}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || (data.pending.length === 0 && body.trim() === "")}>
            Submit review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
