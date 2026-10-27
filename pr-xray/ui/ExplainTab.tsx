// The visual explanation: narrative, diagrams with pinned design comments,
// and what to look at closely.
import { useMemo, useState } from "react";
import { Markdown, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { AnalysisRecord, DiagramNode, ReviewGroup, StoredComment } from "../shared/schema";
import { Composer, TagChip } from "./comments";
import { DiagramCanvas } from "./DiagramCanvas";
import { errorMessage, type ReviewGet, type Rpc } from "./useReview";

const SEVERITY_STYLE = {
  high: "border-destructive/60 text-destructive",
  medium: "border-warning/60 text-warning-text",
  low: "border-border text-muted-foreground",
} as const;

export function ExplainTab({
  data,
  analysis,
  rpc,
  groups,
  onOpenGroup,
  focusGroupId,
}: {
  data: ReviewGet;
  analysis: AnalysisRecord;
  rpc: Rpc;
  groups: ReviewGroup[];
  onOpenGroup: (groupId: string) => void;
  /** Group to highlight in the diagrams ("Show in diagram"). */
  focusGroupId: { groupId: string; nonce: number } | null;
}) {
  const result = analysis.result!;
  const navigate = useBbNavigate();
  const groupTitles = useMemo(() => new Map(groups.map((group) => [group.id, group.title])), [groups]);
  const initialDiagram =
    (focusGroupId && result.diagrams.find((diagram) => diagram.nodes.some((node) => node.groupIds.includes(focusGroupId.groupId)))?.id) ??
    result.diagrams[0]!.id;
  const [diagramId, setDiagramId] = useState(initialDiagram);
  const diagram = result.diagrams.find((candidate) => candidate.id === diagramId) ?? result.diagrams[0]!;
  const [selected, setSelected] = useState<DiagramNode | null>(null);
  const diagramComments = data.comments.filter((comment) => comment.source === "diagram");
  const highlight = useMemo(
    () =>
      new Set(
        focusGroupId ? diagram.nodes.filter((node) => node.groupIds.includes(focusGroupId.groupId)).map((node) => node.id) : [],
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [focusGroupId?.nonce, diagram],
  );

  const fixAll = async () => {
    try {
      const { threadId } = await rpc.call("fix.allDiagram", { ref: data.pr.ref });
      // Stay here; open the thread from the toast when the plan is ready.
      toast.success("Started a redesign thread; it will post a plan first", {
        action: { label: "Open", onClick: () => navigate.toThread(threadId) },
      });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const GroupLinks = ({ ids }: { ids: string[] }) =>
    ids.length === 0 ? null : (
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {ids
          .filter((id) => groupTitles.has(id))
          .map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onOpenGroup(id)}
              className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-state-hover hover:text-foreground"
            >
              <Icon name="FileDiff" className="size-3" />
              {groupTitles.get(id)}
            </button>
          ))}
      </div>
    );

  const open = diagramComments.filter((comment) => comment.status === "open");
  const outdated = diagramComments.filter((comment) => comment.status === "outdated");
  const resolved = diagramComments.filter((comment) => comment.status === "resolved");

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1400px] space-y-6 p-4 md:p-6">
          <section className="space-y-2">
            <h2 className="text-base font-semibold">What this PR does</h2>
            <Markdown content={result.summary} />
            {result.ticket.url ? (
              <p className="text-xs text-muted-foreground">
                Ticket:{" "}
                <a className="underline" href={result.ticket.url} target="_blank" rel="noreferrer">
                  {result.ticket.title ?? result.ticket.url}
                </a>
                {result.ticket.projectTitle ? ` · Project: ${result.ticket.projectTitle}` : ""}
              </p>
            ) : null}
          </section>

          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">Diagrams</h2>
              <div className="flex flex-wrap gap-1">
                {result.diagrams.map((candidate) => (
                  <Button
                    key={candidate.id}
                    size="sm"
                    variant="ghost"
                    aria-pressed={candidate.id === diagram.id}
                    onClick={() => {
                      setDiagramId(candidate.id);
                      setSelected(null);
                    }}
                  >
                    {candidate.title}
                  </Button>
                ))}
              </div>
              <span className="ml-auto text-xs text-muted-foreground">Click a node to comment · ⌘/Ctrl + scroll to zoom · drag to pan</span>
            </div>
            {diagram.description ? <p className="text-sm text-muted-foreground">{diagram.description}</p> : null}
            <div className="h-[60vh]">
              <DiagramCanvas
                diagram={diagram}
                comments={diagramComments}
                selectedNodeId={selected?.id ?? null}
                highlightNodeIds={highlight}
                onSelectNode={setSelected}
              />
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold">Walkthrough</h2>
            <ol className="space-y-4">
              {result.narrative.map((step, index) => (
                <li key={index} className="flex gap-3">
                  <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-xs">{index + 1}</span>
                  <div className="min-w-0">
                    <div className="font-medium">{step.title}</div>
                    <Markdown content={step.body} className="text-sm" />
                    <GroupLinks ids={step.groupIds} />
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {result.lookClosely.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-base font-semibold">Where to look closely</h2>
              <ul className="space-y-2">
                {result.lookClosely.map((item, index) => (
                  <li key={index} className={cn("rounded-lg border-l-4 border bg-card px-3 py-2", SEVERITY_STYLE[item.severity])}>
                    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                      {item.title}
                      <span className="text-[11px] font-normal uppercase">{item.severity}</span>
                    </div>
                    <p className="text-sm text-muted-foreground">{item.reason}</p>
                    <GroupLinks ids={item.groupIds} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>

      <aside className="flex w-80 shrink-0 flex-col border-l border-border">
        {selected ? (
          <NodePanel
            key={`${diagram.id}/${selected.id}`}
            data={data}
            analysis={analysis}
            diagramId={diagram.id}
            node={selected}
            comments={diagramComments.filter((comment) => comment.diagramId === diagram.id && comment.nodeId === selected.id)}
            rpc={rpc}
            groupLinks={<GroupLinks ids={selected.groupIds} />}
            onClose={() => setSelected(null)}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-b border-border p-3">
              <div className="text-sm font-medium">Design comments</div>
              <p className="text-xs text-muted-foreground">Kept in bb only. Comment on a node when the design is wrong.</p>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
              {diagramComments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No design comments yet. Click a node in the diagram to add one.</p>
              ) : null}
              <CommentList title="Open" comments={open} rpc={rpc} onSelect={(comment) => selectComment(comment)} />
              <CommentList title="Outdated" hint="The node no longer exists in the latest analysis." comments={outdated} rpc={rpc} />
              <CommentList title="Resolved" comments={resolved} rpc={rpc} onSelect={(comment) => selectComment(comment)} />
            </div>
            <div className="border-t border-border p-3">
              <Button className="w-full" size="sm" disabled={open.length === 0} onClick={() => void fixAll()}>
                <Icon name="Bot" />
                Fix all diagram comments{open.length ? ` (${open.length})` : ""}
              </Button>
            </div>
          </div>
        )}
      </aside>
    </div>
  );

  function selectComment(comment: StoredComment) {
    const target = result.diagrams.find((candidate) => candidate.id === comment.diagramId);
    const node = target?.nodes.find((candidate) => candidate.id === comment.nodeId);
    if (!target || !node) return;
    setDiagramId(target.id);
    setSelected(node);
  }
}

function CommentList({
  title,
  hint,
  comments,
  rpc,
  onSelect,
}: {
  title: string;
  hint?: string;
  comments: StoredComment[];
  rpc: Rpc;
  onSelect?: (comment: StoredComment) => void;
}) {
  if (comments.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">
        {title} ({comments.length})
      </div>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
      {comments.map((comment) => (
        <DiagramCommentCard key={comment.id} comment={comment} rpc={rpc} onSelect={onSelect} />
      ))}
    </div>
  );
}

function DiagramCommentCard({ comment, rpc, onSelect }: { comment: StoredComment; rpc: Rpc; onSelect?: (comment: StoredComment) => void }) {
  const call = (promise: Promise<unknown>) => promise.catch((error: unknown) => toast.error(errorMessage(error)));
  return (
    <div className="space-y-1.5 rounded-md border border-border bg-card p-2 text-sm">
      <div className="flex items-center gap-2">
        <button type="button" className="min-w-0 truncate text-xs font-medium hover:underline" onClick={() => onSelect?.(comment)} disabled={!onSelect}>
          {comment.nodeLabel}
        </button>
        <TagChip className="ml-auto" tag={comment.tag} onChange={(tag) => void call(rpc.call("comment.setTag", { commentId: comment.id, tag }))} />
      </div>
      <Markdown content={comment.body} className="text-sm" />
      <div className="flex gap-1">
        {comment.status !== "resolved" ? (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => void call(rpc.call("diagram.updateComment", { id: comment.id, status: "resolved" }))}>
            Resolve
          </Button>
        ) : (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => void call(rpc.call("diagram.updateComment", { id: comment.id, status: "open" }))}>
            Reopen
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => void call(rpc.call("diagram.deleteComment", { id: comment.id }))}>
          Delete
        </Button>
      </div>
    </div>
  );
}

function NodePanel({
  data,
  analysis,
  diagramId,
  node,
  comments,
  rpc,
  groupLinks,
  onClose,
}: {
  data: ReviewGet;
  analysis: AnalysisRecord;
  diagramId: string;
  node: DiagramNode;
  comments: StoredComment[];
  rpc: Rpc;
  groupLinks: React.ReactNode;
  onClose: () => void;
}) {
  const isCurrent = analysis.headSha === data.pr.headSha;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-start gap-2 border-b border-border p-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase text-muted-foreground">
            {node.kind} · {node.status}
          </div>
          <div className="font-medium">{node.label}</div>
          {node.detail ? <p className="mt-1 text-sm text-muted-foreground">{node.detail}</p> : null}
          {groupLinks}
        </div>
        <Button size="icon" variant="ghost" className="size-7" onClick={onClose} aria-label="Close">
          <span aria-hidden className="text-base leading-none">×</span>
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {comments.map((comment) => (
          <DiagramCommentCard key={comment.id} comment={comment} rpc={rpc} />
        ))}
        <Composer
          key={comments.length}
          placeholder="What is wrong with this part of the design?"
          autoFocus={comments.length === 0}
          actions={[
            {
              label: "Comment",
              primary: true,
              run: async (body) => {
                await rpc.call("diagram.addComment", { ref: data.pr.ref, analysisId: analysis.id, diagramId, nodeId: node.id, body });
              },
            },
          ]}
        />
        {!isCurrent ? (
          <p className="text-[11px] text-muted-foreground">This diagram is from an older commit; re-analyse to comment on the latest design.</p>
        ) : null}
      </div>
    </div>
  );
}
