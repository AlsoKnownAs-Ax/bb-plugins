// bb-plugin-project-threads — sidebar thread list grouped by project.
//
// Layout, top to bottom:
//   Working   threads that are running, or finished but not yet dismissed
//             ("Ready"). The check button dismisses one back to its project.
//   <Project> one collapsible section per project, holding the rest.
// With workspaces on, a heading names the active workspace and only its
// projects (and their Working threads) show.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_useSidebarThreads as useSidebarThreads,
  ThreadTitle,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSidebarThreadDraft,
  useSidebarThreadRowStatus,
  useSidebarThreadShortcut,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type {
  ExperimentalSidebarFooterDisclosureController,
  ExperimentalSidebarFooterDisclosureProps,
  PluginSidebarProject,
  PluginSidebarThread,
  PluginThreadActionTarget,
  PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, WorkingEntry, WorkspacesView } from "./server";
import { cn } from "@/lib/utils";
import { PROJECT_EMOJIS } from "@/lib/project-emojis";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { DEFAULT_WORKSPACE_ID, personalThreadWorkspaceId } from "@/lib/workspaces";

type Workspace = WorkspacesView["workspaces"][number];

/** Set in setup; the list's workspace heading opens the same footer panel. */
let workspacesPanel: ExperimentalSidebarFooterDisclosureController | undefined;

const COLLAPSED_KEY = "bb-plugin-project-threads:collapsed";
const WORKING_SECTION_ID = "__working__";
const BUSY_STATUSES = new Set(["starting", "active", "stopping"]);
const BUSY_RUNTIME = new Set(["provisioning", "waiting-for-host"]);
const DEFAULT_MAX_THREADS = 5;

function isBusy(thread: PluginSidebarThread): boolean {
  return (
    BUSY_STATUSES.has(thread.status) || BUSY_RUNTIME.has(thread.runtimeStatus)
  );
}

/** Newest activity first, pinned threads above the rest. */
function compareThreads(a: PluginSidebarThread, b: PluginSidebarThread) {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
  return (
    Math.max(b.latestAttentionAt, b.updatedAt) -
    Math.max(a.latestAttentionAt, a.updatedAt)
  );
}

// ---------------------------------------------------------------- state

/** Server-tracked Working entries, refreshed over realtime. */
function useWorkingEntries() {
  const rpc = useRpc<typeof rpcContract>();
  const [entries, setEntries] = useState<ReadonlyMap<string, WorkingEntry>>(
    () => new Map(),
  );
  const refetch = useCallback(() => {
    rpc.call("working_list", null).then(
      (result) =>
        setEntries(new Map(result.entries.map((e) => [e.threadId, e]))),
      () => undefined,
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("working-changed", refetch);
  const dismiss = useCallback(
    (threadId: string) => {
      // Optimistic: drop it locally, then confirm with the server.
      setEntries((prev) => {
        const next = new Map(prev);
        next.delete(threadId);
        return next;
      });
      rpc.call("working_dismiss", { threadId }).then(refetch, refetch);
    },
    [rpc, refetch],
  );
  return { entries, dismiss };
}

/** Project id → emoji, stored on the server and refreshed over realtime. */
function useProjectEmojis() {
  const rpc = useRpc<typeof rpcContract>();
  const [emojis, setEmojis] = useState<Readonly<Record<string, string>>>({});
  const refetch = useCallback(() => {
    rpc.call("emojis_list", null).then(
      (result) => setEmojis(result.emojis),
      () => undefined,
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("emojis-changed", refetch);
  const set = useCallback(
    (projectId: string, emoji: string | null) => {
      rpc
        .call("emojis_set", {
          projectId,
          emoji: emoji as (typeof PROJECT_EMOJIS)[number] | null,
        })
        .then((result) => setEmojis(result.emojis), refetch);
    },
    [rpc, refetch],
  );
  return { emojis, set };
}

/** Workspaces and the active one, stored on the server and refreshed over realtime. */
function useWorkspaces() {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<WorkspacesView>();
  const refetch = useCallback(() => {
    rpc.call("workspaces_list", null).then(setView, () => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("workspaces-changed", refetch);
  const apply = useCallback(
    (viewPromise: Promise<WorkspacesView>) => {
      viewPromise.then(setView, refetch);
    },
    [refetch],
  );
  return { rpc, view, apply };
}

function useWorkspacesEnabled(): boolean {
  return useSettings().values?.workspacesEnabled === true;
}

/** The workspace whose projects the list shows; undefined shows every project. */
function shownWorkspace(
  enabled: boolean,
  view: WorkspacesView | undefined,
): Workspace | undefined {
  if (!enabled || view === undefined) {
    return undefined;
  }

  return view.workspaces.find(({ id }) => id === view.activeId) ?? view.workspaces[0];
}

/** Closes a popover on an outside pointer press or Escape. */
function useDismiss(
  open: boolean,
  rootRef: RefObject<HTMLElement | null>,
  close: () => void,
) {
  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        close();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, rootRef, close]);
}

function withEmoji(emoji: string | undefined, name: string): string {
  return emoji === undefined ? name : `${emoji} ${name}`;
}

/** Collapsed section ids, persisted per client. */
function useCollapsed() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_KEY);
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      return new Set(
        Array.isArray(parsed)
          ? parsed.filter((v): v is string => typeof v === "string")
          : [],
      );
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Storage unavailable; keep the in-memory state.
      }
      return next;
    });
  }, []);
  return { collapsed, toggle };
}

// ---------------------------------------------------------------- glyphs

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cn(
        "size-3 shrink-0 transition-transform",
        open && "rotate-90",
      )}
    >
      <path
        d="M6 4l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5">
      <path
        d="M3.5 8.5l3 3 6-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5">
      <path
        d="M8 3.5v9M3.5 8h9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------- rows
//
// Styling follows T3 Code's sidebar: 36px rows, a muted relative time on the
// right that gives way to a ghost action button on hover, and quiet
// bordered chips for state.

function toActionTarget(thread: PluginSidebarThread): PluginThreadActionTarget {
  const env = thread.environment;
  return {
    ...thread,
    environment:
      env === null || env.id === null ? null : { id: env.id, path: env.path },
  };
}

function relativeTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  return `${Math.floor(d / 30)}mo`;
}

/** T3's ghost icon button: transparent, muted, brightens on hover. */
const ghostButton =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1 rounded-md bg-transparent text-xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

type WorkingState =
  | { kind: "running" }
  | { kind: "ready"; failed: boolean; onDismiss: () => void };

const ThreadRow = memo(function ThreadRow({
  thread,
  depth,
  isActive,
  projectName,
  working,
  onNavigate,
}: {
  thread: PluginSidebarThread;
  depth: number;
  isActive: boolean;
  projectName?: string;
  working?: WorkingState;
  onNavigate: () => void;
}) {
  const { hasUnsubmittedDraft } = useSidebarThreadDraft(thread.id);
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  const shortcut = useSidebarThreadShortcut(thread.id);
  const indicator =
    hasUnsubmittedDraft && thread.indicator === "none"
      ? "draft"
      : thread.indicator;
  const timestamp = Math.max(thread.latestAttentionAt, thread.updatedAt);

  return (
    <ThreadActionsContextMenu thread={toActionTarget(thread)}>
      <div
        className={cn(
          "group/row relative flex w-full items-center overflow-hidden rounded-md text-sm select-none",
          projectName === undefined ? "h-9" : "h-11",
          isActive
            ? "bg-accent text-foreground"
            : "bg-transparent text-foreground/90 hover:bg-accent/50",
        )}
      >
        <a
          href={thread.href}
          onClick={onNavigate}
          data-sidebar-thread-shortcut-target=""
          data-sidebar-thread-id={thread.id}
          aria-label={thread.displayTitle}
          aria-current={isActive ? "page" : undefined}
          aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md pr-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          style={{ paddingLeft: 10 + depth * 14 }}
        >
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center transition-opacity",
              !isActive &&
                indicator === "none" &&
                "opacity-40 group-hover/row:opacity-100",
            )}
          >
            <ThreadStatusGlyph
              indicator={indicator}
              rowStatus={rowStatus}
              size="compact"
            />
          </span>
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span
              className={cn(
                "truncate",
                thread.isUnread ? "font-semibold text-foreground" : "font-normal",
              )}
            >
              <ThreadTitle threadId={thread.id} />
            </span>
            {projectName === undefined ? null : (
              <span className="mt-0.5 truncate text-xs text-muted-foreground">
                {projectName}
              </span>
            )}
          </span>
        </a>

        {/* Right slot: time / state, swapped for actions on hover. */}
        <span className="relative mr-1.5 flex h-6 min-w-8 shrink-0 items-center justify-end gap-1">
          {shortcut !== null ? (
            <span className="inline-flex h-5 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-[10px] font-medium tracking-tight text-foreground shadow-sm">
              {shortcut.label}
            </span>
          ) : working === undefined ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {relativeTime(timestamp)}
            </span>
          ) : working.kind === "running" ? (
            <span className="inline-flex h-5 items-center gap-1.5 rounded-sm border border-border bg-muted/40 px-1.5 text-[10px] font-medium text-muted-foreground">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-500/60" />
                <span className="relative inline-flex size-1.5 rounded-full bg-sky-500" />
              </span>
              Working
            </span>
          ) : (
            <>
              <span
                role="status"
                className={cn(
                  "inline-flex h-5 items-center gap-1 rounded-sm border px-1.5 text-[10px] font-medium",
                  working.failed
                    ? "border-destructive/40 bg-destructive/10 text-destructive"
                    : "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                )}
              >
                {working.failed ? "Failed" : "Ready"}
              </span>
              <button
                type="button"
                onClick={working.onDismiss}
                title="Settle — move back to project"
                aria-label={`Settle ${thread.displayTitle}`}
                className={cn(ghostButton, "h-6 px-1.5")}
              >
                <CheckGlyph />
              </button>
            </>
          )}
        </span>
      </div>
    </ThreadActionsContextMenu>
  );
});

// ---------------------------------------------------------------- sections

function SectionHeader({
  title,
  count,
  open,
  onToggle,
  accent,
  action,
  menu,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  accent?: boolean;
  action?: ReactNode;
  menu?: ReactNode;
}) {
  return (
    <div className="group/header relative mx-0.5 flex h-8 items-center gap-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-sm font-medium outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          accent ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <Chevron open={open} />
        <span className="truncate">{title}</span>
        <span className="ml-auto pl-2 text-xs font-normal tabular-nums text-muted-foreground transition-opacity group-hover/header:opacity-0">
          {count}
        </span>
      </button>
      {action}
      {menu}
    </div>
  );
}

/**
 * A project's threads, with child threads nested under their parent. Only the
 * first `limit` roots show until "Show more" is clicked (0 = no limit).
 */
function ThreadTree({
  threads,
  activeThreadId,
  onNavigate,
  limit = 0,
}: {
  threads: readonly PluginSidebarThread[];
  activeThreadId: string | null;
  onNavigate: () => void;
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const { roots, childrenOf } = useMemo(() => {
    const ids = new Set(threads.map((t) => t.id));
    const childrenOf = new Map<string, PluginSidebarThread[]>();
    const roots: PluginSidebarThread[] = [];
    for (const thread of threads) {
      const parent = thread.parentThreadId;
      if (parent !== null && ids.has(parent)) {
        const list = childrenOf.get(parent) ?? [];
        list.push(thread);
        childrenOf.set(parent, list);
      } else {
        roots.push(thread);
      }
    }
    roots.sort(compareThreads);
    for (const list of childrenOf.values()) list.sort(compareThreads);
    return { roots, childrenOf };
  }, [threads]);

  const render = (thread: PluginSidebarThread, depth: number): ReactNode => (
    <li key={thread.id}>
      <ThreadRow
        thread={thread}
        depth={depth}
        isActive={thread.id === activeThreadId}
        onNavigate={onNavigate}
      />
      {childrenOf.has(thread.id) ? (
        <ul>
          {childrenOf.get(thread.id)!.map((c) => render(c, depth + 1))}
        </ul>
      ) : null}
    </li>
  );
  const capped = !expanded && limit > 0 && roots.length > limit;
  // Keep the active thread reachable even when it falls past the limit.
  const shown = capped
    ? roots.filter(
        (t, i) =>
          i < limit ||
          t.id === activeThreadId ||
          childrenOf.get(t.id)?.some((c) => c.id === activeThreadId),
      )
    : roots;
  return (
    <ul>
      {shown.map((t) => render(t, 0))}
      {limit > 0 && roots.length > limit ? (
        <li>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className={cn(ghostButton, "h-7 w-full justify-start px-2.5")}
          >
            {expanded ? "Show less" : `Show ${roots.length - shown.length} more`}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

// ---------------------------------------------------------------- list

function ProjectThreadList({
  activeThreadId,
  onNavigate,
}: PluginThreadListProps) {
  const { status, threads, projects } = useSidebarThreads();
  const { entries, dismiss } = useWorkingEntries();
  const { collapsed, toggle } = useCollapsed();
  const navigate = useBbNavigate();
  const maxSetting = useSettings().values?.maxThreadsPerProject;
  const { emojis } = useProjectEmojis();
  const maxThreads =
    typeof maxSetting === "number" ? maxSetting : DEFAULT_MAX_THREADS;
  const { rpc, view, apply } = useWorkspaces();
  const workspace = shownWorkspace(useWorkspacesEnabled(), view);
  const personalThreadWorkspaceIds = view?.personalThreadWorkspaceIds;

  // Runs with workspaces off too, so projects made meanwhile still land in
  // the active workspace rather than nowhere.
  const projectIdsKey = projects.map(({ id }) => id).join(",");
  useEffect(() => {
    if (status !== "ready") {
      return;
    }

    apply(
      rpc.call("workspaces_sync", {
        projectIds: projects.map(({ id }) => id),
        personalProjectId: projects.find(({ isPersonal }) => isPersonal)?.id ?? null,
      }),
    );
    // projectIdsKey stands in for `projects`, whose identity changes on every update.
  }, [status, projectIdsKey, rpc, apply]);

  const { working, byProject, projectNames } = useMemo(() => {
    const projectNames = new Map(
      projects.map((p) => [p.id, withEmoji(emojis[p.id], p.name)]),
    );
    const members = workspace && new Set(workspace.projectIds);
    const personalId = projects.find(({ isPersonal }) => isPersonal)?.id;
    const working: { thread: PluginSidebarThread; busy: boolean }[] = [];
    const byProject = new Map<string, PluginSidebarThread[]>();
    for (const thread of threads) {
      if (thread.isHidden || thread.isArchived) continue;
      // Each workspace has its own Personal threads.
      if (
        workspace &&
        thread.projectId === personalId &&
        personalThreadWorkspaceId(personalThreadWorkspaceIds, thread.id) !== workspace.id
      ) {
        continue;
      }
      const busy = isBusy(thread);
      if (busy || entries.has(thread.id)) {
        if (members && !members.has(thread.projectId)) continue;
        working.push({ thread, busy });
        continue;
      }
      const list = byProject.get(thread.projectId) ?? [];
      list.push(thread);
      byProject.set(thread.projectId, list);
    }
    // Running first, then Ready by most recently finished.
    working.sort((a, b) => {
      if (a.busy !== b.busy) return a.busy ? -1 : 1;
      const at = entries.get(a.thread.id)?.changedAt ?? a.thread.updatedAt;
      const bt = entries.get(b.thread.id)?.changedAt ?? b.thread.updatedAt;
      return bt - at;
    });
    return { working, byProject, projectNames };
  }, [threads, projects, entries, emojis, workspace, personalThreadWorkspaceIds]);

  if (status === "loading") {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">Loading threads…</p>
    );
  }
  if (status === "error") {
    return (
      <p role="alert" className="px-3 py-2 text-xs text-destructive">
        Couldn't load threads.
      </p>
    );
  }

  const visibleProjects = projectsToShow(projects, byProject, workspace);
  // Threads whose project isn't in the list (shouldn't happen, but be safe).
  const orphanIds = [...byProject.keys()].filter((id) => !projectNames.has(id));

  const workingOpen = !collapsed.has(WORKING_SECTION_ID);

  return (
    <nav aria-label="Threads" className="flex flex-col gap-3 px-1.5 pb-3 pt-1">
      {workspace ? (
        <button
          type="button"
          onClick={() => workspacesPanel?.toggle()}
          title="Switch workspace"
          className={cn(ghostButton, "mx-0.5 h-8 justify-start gap-2 px-2 text-sm")}
        >
          <Icon name="Layers" aria-hidden className="size-3.5" />
          <span className="truncate font-medium text-foreground">
            {workspace.name}
          </span>
        </button>
      ) : null}

      {working.length === 0 ? null : (
        <section>
          <SectionHeader
            title="Working"
            count={working.length}
            open={workingOpen}
            onToggle={() => toggle(WORKING_SECTION_ID)}
            accent
          />
          {workingOpen ? (
            <ul>
              {working.map(({ thread, busy }) => {
                const entry = entries.get(thread.id);
                const state: WorkingState = busy
                  ? { kind: "running" }
                  : {
                      kind: "ready",
                      failed: entry?.failed ?? false,
                      onDismiss: () => dismiss(thread.id),
                    };
                return (
                  <li key={thread.id}>
                    <ThreadRow
                      thread={thread}
                      depth={0}
                      isActive={thread.id === activeThreadId}
                      projectName={projectNames.get(thread.projectId)}
                      working={state}
                      onNavigate={onNavigate}
                    />
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
      )}

      {visibleProjects.map((project) => {
        const list = byProject.get(project.id) ?? [];
        const open = !collapsed.has(project.id);
        return (
          <section key={project.id}>
            <SectionHeader
              title={projectNames.get(project.id) ?? project.name}
              count={list.length}
              open={open}
              onToggle={() => toggle(project.id)}
              action={
                <button
                  type="button"
                  onClick={() => {
                    navigate.toCompose({
                      projectId: project.id,
                      focusPrompt: true,
                    });
                    onNavigate();
                  }}
                  title={`New thread in ${project.name}`}
                  aria-label={`New thread in ${project.name}`}
                  className={cn(
                    ghostButton,
                    "pointer-events-none absolute right-1 size-6 opacity-0 transition-opacity focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/header:pointer-events-auto group-hover/header:opacity-100",
                  )}
                >
                  <PlusGlyph />
                </button>
              }
              menu={
                view && workspace ? (
                  <ProjectWorkspacesMenu
                    project={project}
                    view={view}
                    workspace={workspace}
                    onChange={apply}
                  />
                ) : null
              }
            />
            {open ? (
              <ThreadTree
                threads={list}
                activeThreadId={activeThreadId}
                onNavigate={onNavigate}
                limit={maxThreads}
              />
            ) : null}
          </section>
        );
      })}

      {orphanIds.map((id) => {
        const list = byProject.get(id) ?? [];
        const open = !collapsed.has(id);
        return (
          <section key={id}>
            <SectionHeader
              title="Other"
              count={list.length}
              open={open}
              onToggle={() => toggle(id)}
            />
            {open ? (
              <ThreadTree
                threads={list}
                activeThreadId={activeThreadId}
                onNavigate={onNavigate}
              />
            ) : null}
          </section>
        );
      })}

      {working.length === 0 && visibleProjects.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">No threads yet.</p>
      ) : null}
    </nav>
  );
}

/**
 * Without a workspace: host order, only projects with threads. In a
 * workspace: its own order, empty projects included, since the user put them there.
 */
function projectsToShow(
  projects: readonly PluginSidebarProject[],
  byProject: ReadonlyMap<string, readonly PluginSidebarThread[]>,
  workspace: Workspace | undefined,
): PluginSidebarProject[] {
  if (workspace === undefined) {
    return projects.filter((p) => (byProject.get(p.id)?.length ?? 0) > 0);
  }

  const byId = new Map(projects.map((p) => [p.id, p]));
  return workspace.projectIds
    .map((id) => byId.get(id))
    .filter((p): p is PluginSidebarProject => p !== undefined);
}

const popoverPanel =
  "absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border border-border bg-background p-1.5 text-foreground shadow-lg";
const menuItem =
  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent";

/** A project header's "…" menu: which workspaces it's in, and its place in this one. */
function ProjectWorkspacesMenu({
  project,
  view,
  workspace,
  onChange,
}: {
  project: PluginSidebarProject;
  view: WorkspacesView;
  workspace: Workspace;
  onChange: (viewPromise: Promise<WorkspacesView>) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, rootRef, close);
  const position = workspace.projectIds.indexOf(project.id);
  const setMember = (workspaceId: string, member: boolean) =>
    onChange(
      rpc.call("workspace_set_project", { workspaceId, projectId: project.id, member }),
    );
  const move = (direction: "up" | "down") =>
    onChange(
      rpc.call("workspace_move_project", {
        workspaceId: workspace.id,
        projectId: project.id,
        direction,
      }),
    );

  return (
    <div
      ref={rootRef}
      className={cn(
        "pointer-events-none absolute right-8 opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover/header:pointer-events-auto group-hover/header:opacity-100",
        open && "pointer-events-auto opacity-100",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`${project.name} options`}
        aria-label={`${project.name} options`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(ghostButton, "size-6")}
      >
        <Icon name="Ellipsis" fallback="MoreHorizontal" aria-hidden className="size-3.5" />
      </button>
      {open ? (
        <div role="dialog" aria-label={`${project.name} options`} className={popoverPanel}>
          <p className="px-2 pb-1 pt-0.5 text-xs text-muted-foreground">Workspaces</p>
          {view.workspaces.map((candidate) => (
            <label key={candidate.id} className={menuItem}>
              <Checkbox
                checked={candidate.projectIds.includes(project.id)}
                onCheckedChange={(checked) => setMember(candidate.id, checked === true)}
              />
              <span className="truncate">{candidate.name}</span>
            </label>
          ))}
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            disabled={position <= 0}
            onClick={() => move("up")}
            className={menuItem}
          >
            Move up
          </button>
          <button
            type="button"
            disabled={position === -1 || position === workspace.projectIds.length - 1}
            onClick={() => move("down")}
            className={menuItem}
          >
            Move down
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The sidebar footer's Workspaces panel: switch, create, rename, delete. */
function WorkspacesPanel({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  const enabled = useWorkspacesEnabled();
  const { rpc, view, apply } = useWorkspaces();
  const [name, setName] = useState("");

  if (!enabled) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        Workspaces are off. Turn on "Enable workspaces" in the Project Threads
        plugin settings.
      </p>
    );
  }

  if (view === undefined) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">Loading workspaces…</p>;
  }

  const create = () => {
    const trimmed = name.trim();

    if (!trimmed) {
      return;
    }

    apply(rpc.call("workspace_create", { name: trimmed }));
    setName("");
  };

  return (
    <div className="flex flex-col gap-1 p-1.5">
      <ul className="flex flex-col">
        {view.workspaces.map((workspace) => (
          <li key={workspace.id}>
            <WorkspaceRow
              workspace={workspace}
              isActive={workspace.id === view.activeId}
              onSwitch={() => {
                apply(rpc.call("workspace_switch", { workspaceId: workspace.id }));
                dismiss();
              }}
              onRename={(newName) =>
                apply(rpc.call("workspace_rename", { workspaceId: workspace.id, name: newName }))
              }
              onDelete={() =>
                apply(rpc.call("workspace_delete", { workspaceId: workspace.id }))
              }
            />
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
        className="flex items-center gap-1.5 border-t border-border pt-1.5"
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          placeholder="New workspace"
          aria-label="New workspace name"
          className="h-7 text-sm"
        />
        <button type="submit" className={cn(ghostButton, "h-7 px-2")}>
          Create
        </button>
      </form>
    </div>
  );
}

type WorkspaceRowMode = "idle" | "renaming" | "confirming-delete";

function WorkspaceRow({
  workspace,
  isActive,
  onSwitch,
  onRename,
  onDelete,
}: {
  workspace: Workspace;
  isActive: boolean;
  onSwitch: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [mode, setMode] = useState<WorkspaceRowMode>("idle");
  const canDelete = workspace.id !== DEFAULT_WORKSPACE_ID;

  if (mode === "renaming") {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = new FormData(e.currentTarget).get("name")?.toString().trim();

          if (trimmed) {
            onRename(trimmed);
          }

          setMode("idle");
        }}
        className="flex items-center gap-1.5 py-0.5"
      >
        <Input
          name="name"
          defaultValue={workspace.name}
          maxLength={60}
          autoFocus
          aria-label={`Rename ${workspace.name}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setMode("idle");
            }
          }}
          className="h-7 text-sm"
        />
        <button type="submit" className={cn(ghostButton, "h-7 px-2")}>
          Save
        </button>
      </form>
    );
  }

  if (mode === "confirming-delete") {
    return (
      <div role="alertdialog" aria-label={`Delete ${workspace.name}`} className="rounded-md px-2 py-1.5 text-sm">
        <p>
          Delete "{workspace.name}"? Its Personal threads won't show in any
          workspace, and projects only in this workspace won't be in any.
        </p>
        <div className="mt-1.5 flex justify-end gap-1">
          <button type="button" onClick={() => setMode("idle")} className={cn(ghostButton, "h-7 px-2")}>
            Cancel
          </button>
          <button
            type="button"
            onClick={onDelete}
            className={cn(ghostButton, "h-7 px-2 text-destructive hover:text-destructive")}
          >
            Delete
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group/workspace flex items-center gap-1 rounded-md hover:bg-accent/50">
      <button
        type="button"
        onClick={onSwitch}
        aria-current={isActive}
        className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {isActive ? <CheckGlyph /> : null}
        </span>
        <span className={cn("truncate", isActive && "font-medium")}>{workspace.name}</span>
      </button>
      <span className="flex shrink-0 gap-0.5 pr-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/workspace:opacity-100">
        <button type="button" onClick={() => setMode("renaming")} className={cn(ghostButton, "h-6 px-1.5")}>
          Rename
        </button>
        {canDelete ? (
          <button type="button" onClick={() => setMode("confirming-delete")} className={cn(ghostButton, "h-6 px-1.5")}>
            Delete
          </button>
        ) : null}
      </span>
    </div>
  );
}

/** Windows-style emoji picker: a button that opens a 5-column grid. */
function EmojiPicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string | undefined;
  onChange: (emoji: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, rootRef, close);
  const pick = (emoji: string | null) => {
    onChange(emoji);
    setOpen(false);
  };
  const cell =
    "flex size-9 cursor-pointer items-center justify-center rounded-md text-xl outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div ref={rootRef} className="relative">
      <button
        id={id}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-9 w-14 cursor-pointer items-center justify-center gap-1 rounded-md border border-input bg-background text-lg outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        {value ?? <span className="text-xs text-muted-foreground">None</span>}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Choose an emoji"
          className="absolute right-0 top-full z-50 mt-1 w-max rounded-lg border border-border bg-background p-2 text-foreground shadow-lg"
        >
          <div className="grid max-h-64 grid-cols-5 gap-1 overflow-y-auto">
            {PROJECT_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => pick(emoji)}
                aria-label={emoji}
                aria-pressed={emoji === value}
                className={cn(cell, emoji === value && "bg-accent")}
              >
                {emoji}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => pick(null)}
            className="mt-2 w-full cursor-pointer rounded-md border-t border-border pt-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Remove emoji
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Settings page section: one emoji picker per project. */
function ProjectEmojiSettings() {
  const { status, projects } = useSidebarThreads();
  const { emojis, set } = useProjectEmojis();
  if (status === "loading") {
    return <p className="text-sm text-muted-foreground">Loading projects…</p>;
  }
  if (status === "error") {
    return (
      <p role="alert" className="text-sm text-destructive">
        Couldn't load projects.
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-border">
      {projects.map((project) => (
        <li key={project.id} className="flex items-center gap-3 py-2">
          <label
            htmlFor={`emoji-${project.id}`}
            className="min-w-0 flex-1 truncate text-sm"
          >
            {project.name}
          </label>
          <EmojiPicker
            id={`emoji-${project.id}`}
            value={emojis[project.id]}
            onChange={(emoji) => set(project.id, emoji)}
          />
        </li>
      ))}
    </ul>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "project-emojis",
    title: "Project emojis",
    description: "Shown before each project's name in the sidebar.",
    component: ProjectEmojiSettings,
  });
  app.slots.experimental_threadList({
    id: "by-project",
    title: "By project",
    description:
      "Threads grouped into collapsible project sections, with a Working section for running and ready threads.",
    component: ProjectThreadList,
  });
  workspacesPanel = app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "workspaces",
    label: "Workspaces",
    icon: "Layers",
    component: WorkspacesPanel,
  });
});
