// Pan/zoom canvas for one analysis diagram, laid out with dagre. Nodes carry
// Figma-style comment pins.
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import dagre from "@dagrejs/dagre";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Diagram, DiagramNode, StoredComment } from "../shared/schema";

const NODE_W = 220;
const NODE_H = 72;

interface Layout {
  nodes: Map<string, { x: number; y: number }>;
  edges: { from: string; to: string; label?: string; status: string; points: { x: number; y: number }[] }[];
  width: number;
  height: number;
}

function layoutDiagram(diagram: Diagram): Layout {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: diagram.kind === "data-model" ? "TB" : "LR",
    nodesep: 40,
    ranksep: diagram.kind === "sequence" ? 90 : 70,
    marginx: 40,
    marginy: 40,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of diagram.nodes) graph.setNode(node.id, { width: NODE_W, height: NODE_H });
  diagram.edges.forEach((edge, index) => {
    graph.setEdge(edge.from, edge.to, { label: edge.label, width: edge.label ? Math.min(180, edge.label.length * 6.5) : 0, height: edge.label ? 18 : 0 }, `e${index}`);
  });
  dagre.layout(graph);
  const nodes = new Map<string, { x: number; y: number }>();
  for (const node of diagram.nodes) {
    const position = graph.node(node.id);
    nodes.set(node.id, { x: position.x - NODE_W / 2, y: position.y - NODE_H / 2 });
  }
  const edges = diagram.edges.map((edge, index) => {
    const data = graph.edge({ v: edge.from, w: edge.to, name: `e${index}` }) as { points?: { x: number; y: number }[] } | undefined;
    return { from: edge.from, to: edge.to, label: edge.label, status: edge.status, points: data?.points ?? [] };
  });
  const meta = graph.graph();
  return { nodes, edges, width: meta.width ?? 800, height: meta.height ?? 600 };
}

const STATUS_STYLE: Record<string, string> = {
  added: "border-success/70 bg-success/10",
  modified: "border-warning/70 bg-warning/10",
  removed: "border-destructive/70 bg-destructive/10 opacity-80",
  unchanged: "border-border bg-card",
};
const EDGE_STYLE: Record<string, string> = {
  added: "stroke-success",
  modified: "stroke-warning",
  removed: "stroke-destructive",
  unchanged: "stroke-muted-foreground",
};

export function DiagramCanvas({
  diagram,
  comments,
  selectedNodeId,
  highlightNodeIds,
  onSelectNode,
}: {
  diagram: Diagram;
  comments: StoredComment[];
  selectedNodeId: string | null;
  highlightNodeIds: Set<string>;
  onSelectNode: (node: DiagramNode | null) => void;
}) {
  const layout = useMemo(() => layoutDiagram(diagram), [diagram]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  const fit = () => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    const scale = Math.min(1.2, Math.max(0.7, Math.min(box.width / layout.width, box.height / layout.height) * 0.95));
    setView({ scale, x: (box.width - layout.width * scale) / 2, y: (box.height - layout.height * scale) / 2 });
  };
  useEffect(fit, [layout]);

  // Bring highlighted nodes (from "Show in diagram") into view.
  useEffect(() => {
    const first = [...highlightNodeIds].map((id) => layout.nodes.get(id)).find(Boolean);
    const box = containerRef.current?.getBoundingClientRect();
    if (!first || !box) return;
    setView((current) => ({
      ...current,
      x: box.width / 2 - (first.x + NODE_W / 2) * current.scale,
      y: box.height / 2 - (first.y + NODE_H / 2) * current.scale,
    }));
  }, [highlightNodeIds, layout]);

  const pinsByNode = useMemo(() => {
    const map = new Map<string, StoredComment[]>();
    for (const comment of comments) {
      if (comment.diagramId !== diagram.id || comment.nodeId === null || comment.status === "outdated") continue;
      map.set(comment.nodeId, [...(map.get(comment.nodeId) ?? []), comment]);
    }
    return map;
  }, [comments, diagram.id]);

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-event.deltaY * 0.01);
      setView((current) => {
        const scale = Math.min(2.5, Math.max(0.15, current.scale * factor));
        const px = event.clientX - box.left;
        const py = event.clientY - box.top;
        return { scale, x: px - ((px - current.x) * scale) / current.scale, y: py - ((py - current.y) * scale) / current.scale };
      });
    } else {
      setView((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
    }
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("[data-node]")) return;
    drag.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) state.moved = true;
    setView((current) => ({ ...current, x: state.vx + dx, y: state.vy + dy }));
  };
  const onPointerUp = () => {
    if (drag.current && !drag.current.moved) onSelectNode(null);
    drag.current = null;
  };

  const zoom = (factor: number) => setView((current) => ({ ...current, scale: Math.min(2.5, Math.max(0.15, current.scale * factor)) }));

  return (
    <div
      ref={containerRef}
      className="relative h-full min-h-[420px] w-full cursor-grab overflow-hidden rounded-lg border border-border bg-muted/20 active:cursor-grabbing"
      style={{ backgroundImage: "radial-gradient(currentColor 1px, transparent 1px)", backgroundSize: `${20 * view.scale}px ${20 * view.scale}px`, backgroundPosition: `${view.x}px ${view.y}px`, color: "color-mix(in oklab, var(--color-muted-foreground) 25%, transparent)" }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="absolute left-0 top-0 origin-top-left text-foreground" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        <svg width={layout.width} height={layout.height} className="absolute left-0 top-0 overflow-visible">
          <defs>
            <marker id={`arrow-${diagram.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" />
            </marker>
          </defs>
          {layout.edges.map((edge, index) => {
            if (edge.points.length < 2) return null;
            const d = edge.points.map((point, i) => `${i === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
            const mid = edge.points[Math.floor(edge.points.length / 2)]!;
            return (
              <g key={index}>
                <path d={d} fill="none" strokeWidth={1.5} strokeDasharray={edge.status === "removed" ? "5 4" : undefined} className={EDGE_STYLE[edge.status] ?? EDGE_STYLE.unchanged} markerEnd={`url(#arrow-${diagram.id})`} />
                {edge.label ? (
                  <text x={mid.x} y={mid.y - 6} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                    {edge.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        {diagram.nodes.map((node) => {
          const position = layout.nodes.get(node.id)!;
          const pins = pinsByNode.get(node.id) ?? [];
          const openPins = pins.filter((pin) => pin.status === "open");
          return (
            <button
              key={node.id}
              type="button"
              data-node
              onClick={(event) => {
                event.stopPropagation();
                onSelectNode(node);
              }}
              className={cn(
                "absolute flex flex-col justify-center rounded-lg border-2 px-3 py-2 text-left shadow-xs transition-shadow hover:shadow-md",
                STATUS_STYLE[node.status] ?? STATUS_STYLE.unchanged,
                selectedNodeId === node.id && "ring-2 ring-ring",
                highlightNodeIds.has(node.id) && "ring-2 ring-ring ring-offset-2 ring-offset-background",
              )}
              style={{ left: position.x, top: position.y, width: NODE_W, height: NODE_H }}
              title={node.detail}
            >
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {node.kind}
                {node.status !== "unchanged" ? ` · ${node.status}` : ""}
              </span>
              <span className="line-clamp-2 text-sm font-medium leading-tight">{node.label}</span>
              {pins.length > 0 ? (
                <span
                  className={cn(
                    "absolute -right-2.5 -top-2.5 flex h-6 min-w-6 items-center justify-center rounded-full rounded-bl-none border-2 border-background px-1 text-[11px] font-semibold shadow",
                    openPins.length > 0 ? "bg-foreground text-background" : "bg-muted text-muted-foreground",
                  )}
                  aria-label={`${pins.length} comments`}
                >
                  {pins.length}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-md border border-border bg-background/90 p-1 shadow-xs">
        <Button size="icon" variant="ghost" className="size-7" onClick={() => zoom(1 / 1.2)} aria-label="Zoom out">
          <Icon name="Minus" />
        </Button>
        <span className="w-10 text-center text-xs text-muted-foreground">{Math.round(view.scale * 100)}%</span>
        <Button size="icon" variant="ghost" className="size-7" onClick={() => zoom(1.2)} aria-label="Zoom in">
          <Icon name="Plus" />
        </Button>
        <Button size="icon" variant="ghost" className="size-7" onClick={fit} aria-label="Fit to view">
          <Icon name="Maximize2" />
        </Button>
      </div>
      <div className="absolute bottom-3 left-3 flex items-center gap-3 rounded-md border border-border bg-background/90 px-2 py-1 text-[11px] text-muted-foreground">
        {(["added", "modified", "removed"] as const).map((status) => (
          <span key={status} className="flex items-center gap-1">
            <span className={cn("size-2.5 rounded-sm border-2", STATUS_STYLE[status])} />
            {status}
          </span>
        ))}
      </div>
    </div>
  );
}
