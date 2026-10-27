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
import { ChatBubble } from "./ChatBubble";
import { DiffTab, displayGroups, type ViewMode } from "./DiffTab";
import { ExplainTab } from "./ExplainTab";
import { uiStore } from "./store";
import { errorMessage, useReview } from "./useReview";

type Tab = "diff" | "explain";

function FocusFrame({ focus, children }: { focus: boolean; children: ReactNode }) {
  const scope = usePortalScopeProps();
  if (!focus) return <div className="relative flex h-full min-h-0 flex-1 flex-col">{children}</div>;
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
  const [chatRequest, setChatRequest] = useState<{ threadId: string; nonce: number } | null>(null);

  useEffect(() => {
    if (uiStore.get().focusOnOpen) uiStore.set({ focusOnOpen: false });
  }, []);
  useEffect(() => localStorage.setItem("pr-xray:view", view), [view]);
  useEffect(() => setLocalViewed(new Map()), [data?.viewedHunks]);

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
  /** Fingerprints of viewed hunks, with optimistic local toggles applied. */
  const viewedHunks = useMemo(() => {
    const set = new Set(data?.viewedHunks ?? []);
    for (const [fingerprint, value] of localViewed) {
      if (value) set.add(fingerprint);
      else set.delete(fingerprint);
    }
    return set;
  }, [data?.viewedHunks, localViewed]);

  const setHunksViewed = useCallback(
    (fingerprints: string[], value: boolean) => {
      setLocalViewed((current) => {
        const next = new Map(current);
        for (const fingerprint of fingerprints) next.set(fingerprint, value);
        return next;
      });
      rpc.call("hunks.setViewed", { ref: prRef, fingerprints, viewed: value }).catch((cause: unknown) => toast.error(errorMessage(cause)));
    },
    [prRef, rpc],
  );

  const askChat = useCallback(
    async (question: string) => {
      const { threadId } = await rpc.call("chat.start", { ref: prRef, question });
      setChatRequest({ threadId, nonce: Date.now() });
    },
    [prRef, rpc],
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
        {current || analysis ? (
          <Button size="sm" variant="ghost" onClick={() => void reanalyse()} disabled={running} aria-label="Run the analysis again">
            <Icon name="RotateCcw" className={cn(running && "animate-spin")} />
            {running ? "Analysing…" : "Re-analyse"}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => void reanalyse()} aria-label="Analyse this PR">
            <Icon name="Sparkles" />
            Analyse
          </Button>
        )}
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

      {running && current ? (
        <AnalysisProgress
          startedAt={current.createdAt}
          hasAnalysis={analysis !== null}
          onOpenRun={current.workerThreadId ? () => navigate.toThread(current.workerThreadId!) : null}
        />
      ) : null}
      <Banners
        failed={failed ? (current?.error ?? "Analysis failed.") : null}
        stale={stale && !running}
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
            viewedHunks={viewedHunks}
            onSetViewed={setHunksViewed}
            onAskChat={askChat}
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
        ) : running ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
            <Icon name="Spinner" className="size-6 animate-spin" />
            The explanation appears here when the analysis finishes.
          </div>
        ) : (
          <div className="p-6 text-sm text-muted-foreground">No analysis yet.</div>
        )}
      </div>
      <ChatBubble rpc={rpc} prRef={prRef} openRequest={chatRequest} />
    </FocusFrame>
  );
}

/** Typical run time; the bar eases towards full around here, never reaching it. */
const EXPECTED_MS = 60_000;

function AnalysisProgress({
  startedAt,
  hasAnalysis,
  onOpenRun,
}: {
  startedAt: string;
  hasAnalysis: boolean;
  onOpenRun: (() => void) | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, now - Date.parse(startedAt));
  const seconds = Math.floor(elapsed / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const progress = 1 - Math.exp(-elapsed / (EXPECTED_MS / 2));
  const slow = elapsed > EXPECTED_MS * 3;
  return (
    <div role="status" aria-live="polite" className="border-b border-border bg-muted/40">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs">
        <Icon name="Spinner" className="size-4 animate-spin text-foreground" />
        <span className="font-medium text-foreground">Analysing the PR</span>
        <span className="text-muted-foreground">· reading the diff and ticket, grouping hunks, drawing diagrams</span>
        <span className="font-mono tabular-nums text-muted-foreground">{clock}</span>
        <span className="text-muted-foreground">
          {slow
            ? "Taking longer than usual. Open the run to see what the agent is doing."
            : hasAnalysis
              ? "Showing the previous analysis meanwhile."
              : "Showing the diff by file meanwhile."}
        </span>
        {onOpenRun ? (
          <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-xs" onClick={onOpenRun}>
            <Icon name="Bot" />
            Watch the agent
          </Button>
        ) : null}
      </div>
      <div className="h-0.5 overflow-hidden bg-muted">
        <div className="h-full bg-primary transition-[width] duration-1000 ease-linear" style={{ width: `${Math.round(progress * 95)}%` }} />
      </div>
    </div>
  );
}

function Banners({
  failed,
  stale,
  onReanalyse,
  ticketUrl,
  ticketOverridden,
  onSetTicket,
}: {
  failed: string | null;
  stale: boolean;
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
