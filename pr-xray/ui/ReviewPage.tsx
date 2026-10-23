// One PR's review: header, analysis status, Diff/Explain tabs, focus mode.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";
import type { PrRef } from "../shared/schema";
import { DiffTab, displayGroups, type ViewMode } from "./DiffTab";
import { ExplainTab } from "./ExplainTab";
import { uiStore } from "./store";
import { errorMessage, useReview } from "./useReview";

type Tab = "diff" | "explain";

function FocusFrame({ focus, children }: { focus: boolean; children: ReactNode }) {
  const scope = usePortalScopeProps();
  if (!focus) return <div className="flex h-full min-h-0 flex-1 flex-col">{children}</div>;
  return createPortal(
    <div {...scope} className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      {children}
    </div>,
    document.body,
  );
}

export function ReviewPage({ prRef }: { prRef: PrRef }) {
  const { rpc, data, error, refetch } = useReview(prRef);
  const navigate = useBbNavigate();
  const [tab, setTab] = useState<Tab>("diff");
  const [focus, setFocus] = useState(() => uiStore.get().focusOnOpen);
  const [view, setView] = useState<ViewMode>(() => (localStorage.getItem("pr-xray:view") as ViewMode) ?? "unified");
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [scrollRequest, setScrollRequest] = useState<{ groupId: string; nonce: number } | null>(null);
  const [diagramFocus, setDiagramFocus] = useState<{ groupId: string; nonce: number } | null>(null);
  const [localViewed, setLocalViewed] = useState<Map<string, boolean>>(new Map());

  useEffect(() => {
    if (uiStore.get().focusOnOpen) uiStore.set({ focusOnOpen: false });
  }, []);
  useEffect(() => localStorage.setItem("pr-xray:view", view), [view]);
  useEffect(() => setLocalViewed(new Map()), [data?.completed?.id, data?.viewedGroups]);

  // f toggles focus mode, Esc leaves it, 1/2 switch tabs.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true], [role=dialog]") || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "f") setFocus((value) => !value);
      else if (event.key === "Escape" && focus) setFocus(false);
      else if (event.key === "1") setTab("diff");
      else if (event.key === "2") setTab("explain");
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus]);

  const groups = useMemo(() => (data ? displayGroups(data) : []), [data]);
  const analysis = data?.completed ?? null;
  const viewed = useMemo(() => {
    const set = new Set(data?.viewedGroups ?? []);
    for (const [groupId, value] of localViewed) {
      if (value) set.add(groupId);
      else set.delete(groupId);
    }
    return set;
  }, [data?.viewedGroups, localViewed]);

  const toggleViewed = useCallback(
    (groupId: string, value: boolean) => {
      setLocalViewed((current) => new Map(current).set(groupId, value));
      if (analysis) {
        rpc.call("group.setViewed", { analysisId: analysis.id, groupId, viewed: value }).catch((cause: unknown) => toast.error(errorMessage(cause)));
      }
    },
    [analysis, rpc],
  );

  const reanalyse = async () => {
    try {
      await rpc.call("analysis.start", { ref: prRef });
      refetch();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };

  if (error && !data) {
    return (
      <div className="p-6">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        <Button className="mt-3" size="sm" variant="outline" onClick={refetch}>
          Retry
        </Button>
      </div>
    );
  }
  if (!data) {
    return <div className="p-6 text-sm text-muted-foreground">Loading pull request…</div>;
  }

  const { pr, current } = data;
  const running = current?.status === "running";
  const failed = current?.status === "failed";
  const stale = analysis !== null && analysis.headSha !== pr.headSha;
  const groupHasDiagram = (groupId: string) =>
    analysis?.result?.diagrams.some((diagram) => diagram.nodes.some((node) => node.groupIds.includes(groupId))) ?? false;

  return (
    <FocusFrame focus={focus}>
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <a href={pr.url} target="_blank" rel="noreferrer" className="hover:underline">
              {pr.ref.owner}/{pr.ref.repo}#{pr.ref.number}
            </a>
            <span>·</span>
            <span className="font-mono">
              {pr.headRef} → {pr.baseRef}
            </span>
            <span>·</span>
            <span>{pr.draft ? "draft" : pr.state}</span>
            {analysis?.diffOnly ? <span className="rounded border border-border px-1.5">diff-only analysis</span> : null}
          </div>
          <h1 className="truncate text-base font-semibold">{pr.title}</h1>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          {(["diff", "explain"] as const).map((value, index) => (
            <Button key={value} size="sm" variant="ghost" aria-pressed={tab === value} onClick={() => setTab(value)}>
              <Icon name={value === "diff" ? "FileDiff" : "Workflow"} />
              {value === "diff" ? "Diff" : "Explain"}
            </Button>
          ))}
        </div>
        {tab === "diff" ? (
          <Button size="sm" variant="ghost" onClick={() => setView(view === "unified" ? "split" : "unified")} aria-label="Toggle split view">
            <Icon name={view === "unified" ? "Columns2" : "Rows2"} />
            {view === "unified" ? "Split" : "Unified"}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => void reanalyse()} disabled={running} aria-label="Run the analysis again">
          <Icon name="RotateCcw" className={cn(running && "animate-spin")} />
          {running ? "Analysing…" : "Re-analyse"}
        </Button>
        {analysis?.workerThreadId ? (
          <Button size="sm" variant="ghost" onClick={() => navigate.toThread(analysis.workerThreadId!)} aria-label="Open the agent run behind this analysis">
            <Icon name="Bot" />
            Run
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => setFocus(!focus)} aria-label="Focus mode (f)">
          <Icon name={focus ? "Minimize2" : "Maximize2"} />
          {focus ? "Exit focus" : "Focus"}
        </Button>
        {focus ? (
          <Button size="icon" variant="ghost" className="size-8" onClick={() => setFocus(false)} aria-label="Close focus mode (Esc)">
            <span aria-hidden className="text-base leading-none">×</span>
          </Button>
        ) : null}
      </header>

      <Banners
        running={running}
        failed={failed ? (current?.error ?? "Analysis failed.") : null}
        stale={stale && !running}
        hasAnalysis={analysis !== null}
        onReanalyse={() => void reanalyse()}
        ticketUrl={data.ticketUrl}
        ticketOverridden={data.ticketOverridden}
        onSetTicket={async (url) => {
          await rpc.call("review.setTicket", { ref: prRef, url });
          refetch();
        }}
      />

      <div className="min-h-0 flex-1">
        {tab === "diff" ? (
          <DiffTab
            data={data}
            rpc={rpc}
            view={view}
            groups={groups}
            viewed={viewed}
            onToggleViewed={toggleViewed}
            activeGroupId={activeGroupId}
            onActiveGroupChange={setActiveGroupId}
            scrollRequest={scrollRequest}
            onShowInDiagram={
              analysis?.result
                ? (groupId) => {
                    if (!groupHasDiagram(groupId)) {
                      toast("No diagram node is linked to this group");
                      return;
                    }
                    setDiagramFocus({ groupId, nonce: Date.now() });
                    setTab("explain");
                  }
                : null
            }
          />
        ) : analysis?.result ? (
          <ExplainTab
            data={data}
            analysis={analysis}
            rpc={rpc}
            groups={groups}
            focusGroupId={diagramFocus}
            onOpenGroup={(groupId) => {
              setTab("diff");
              setScrollRequest({ groupId, nonce: Date.now() });
            }}
          />
        ) : (
          <div className="p-6 text-sm text-muted-foreground">
            {running ? "The explanation appears here when the analysis finishes (usually 1–3 minutes)." : "No analysis yet."}
          </div>
        )}
      </div>
    </FocusFrame>
  );
}

function Banners({
  running,
  failed,
  stale,
  hasAnalysis,
  onReanalyse,
  ticketUrl,
  ticketOverridden,
  onSetTicket,
}: {
  running: boolean;
  failed: string | null;
  stale: boolean;
  hasAnalysis: boolean;
  onReanalyse: () => void;
  ticketUrl: string | null;
  ticketOverridden: boolean;
  onSetTicket: (url: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(ticketUrl ?? "");
  const banner = "flex flex-wrap items-center gap-2 border-b border-border px-4 py-1.5 text-xs";
  return (
    <>
      {running ? (
        <div className={cn(banner, "bg-muted/40 text-muted-foreground")}>
          <Icon name="Spinner" className="size-3.5 animate-spin" />
          Analysing the PR: grouping hunks, reading the ticket and drawing diagrams. This usually takes 1–3 minutes.
          {hasAnalysis ? " Showing the previous analysis meanwhile." : " Showing the diff by file meanwhile."}
        </div>
      ) : null}
      {failed ? (
        <div className={cn(banner, "text-destructive")}>
          <Icon name="AlertTriangle" className="size-3.5" />
          {failed}
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onReanalyse}>
            Try again
          </Button>
        </div>
      ) : null}
      {stale ? (
        <div className={cn(banner, "bg-muted/40")}>
          <Icon name="Commit" className="size-3.5" />
          New commits since the last analysis.
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onReanalyse}>
            Re-analyse
          </Button>
        </div>
      ) : null}
      {ticketUrl === null || editing ? (
        <div className={cn(banner, "text-muted-foreground")}>
          <Icon name="Link" className="size-3.5" />
          {editing ? "Ticket link:" : "No ticket linked. The analysis will rely on the PR description."}
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const url = value.trim();
              void onSetTicket(url === "" ? null : url)
                .then(() => setEditing(false))
                .catch((error: unknown) => toast.error(errorMessage(error)));
            }}
          >
            <Input value={value} onChange={(event) => setValue(event.target.value)} placeholder="https://www.notion.so/…" className="h-7 w-80 text-xs" />
            <Button size="sm" variant="outline" className="h-7 text-xs" type="submit">
              Save
            </Button>
            {editing ? (
              <Button size="sm" variant="ghost" className="h-7 text-xs" type="button" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            ) : null}
          </form>
          <span>Re-analyse to use it.</span>
        </div>
      ) : (
        <div className={cn(banner, "text-muted-foreground")}>
          <Icon name="Link" className="size-3.5" />
          <a href={ticketUrl} target="_blank" rel="noreferrer" className="max-w-xl truncate hover:underline">
            {ticketUrl}
          </a>
          {ticketOverridden ? <span>(set by you)</span> : null}
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setEditing(true)}>
            Change
          </Button>
        </div>
      )}
    </>
  );
}
