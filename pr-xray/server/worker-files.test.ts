import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import type { PrDetails } from "../shared/schema";
import { createAnalysis } from "./analysis";
import { chatInstructions, createChat } from "./chat";
import { createWorkerDir, removeWorkerDir } from "./worker-files";

const ref = { owner: "acme", repo: "web", number: 7 };
const pr = {
  ref,
  url: "https://github.com/acme/web/pull/7",
  title: "Feature",
  body: "",
  author: "ann",
  state: "open",
  draft: false,
  headSha: "head",
  headRef: "feature",
  baseRef: "main",
  headInBaseRepo: true,
  files: [],
  hunks: [],
  threads: [],
} as unknown as PrDetails;

/** A bb where no project matches the PR, so workers run in the personal project. */
function fakeBb() {
  const metadata = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, (event: { thread: { id: string } }) => void>();
  const kv = new Map<string, unknown>();
  const spawn = vi.fn(async (input: { pluginMetadata: Record<string, unknown> }) => {
    metadata.set("thr_1", input.pluginMetadata);
    return { id: "thr_1" };
  });
  const bb = {
    log: { warn: vi.fn() },
    realtime: { publish: vi.fn() },
    agents: { registerTool: vi.fn() },
    background: { schedule: vi.fn() },
    events: { on: (name: string, handler: (event: { thread: { id: string } }) => void) => handlers.set(name, handler) },
    storage: {
      kv: {
        get: async (key: string) => kv.get(key) ?? null,
        set: async (key: string, value: unknown) => void kv.set(key, value),
        delete: async (key: string) => void kv.delete(key),
      },
    },
    sdk: {
      projects: { list: async () => [{ id: "personal", kind: "personal" }] },
      threads: {
        spawn,
        send: vi.fn(async () => undefined),
        get: async () => ({ deletedAt: null, archivedAt: null, status: "idle" }),
        getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata.get(threadId) ?? {},
        archive: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
      },
    },
  };
  return { bb: bb as unknown as BbPluginApi, spawn, handlers, metadata };
}

describe("worker temp folders", () => {
  it("are private to this OS user and removable", async () => {
    const dir = await createWorkerDir();
    if (process.platform !== "win32") expect(statSync(dir).mode & 0o077).toBe(0);
    await removeWorkerDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("refuse to delete anything else", async () => {
    const other = join(tmpdir(), `not-ours-${process.pid}`);
    mkdirSync(other, { recursive: true });
    await removeWorkerDir(other);
    await removeWorkerDir(join(other, "pr-xray-nested"));
    await removeWorkerDir(undefined);
    expect(existsSync(other)).toBe(true);
    rmSync(other, { recursive: true });
  });
});

describe("the analysis diff", () => {
  function setup() {
    const fake = fakeBb();
    const record = { id: "an_1", ref, status: "done", workerThreadId: "thr_1" };
    const store = {
      runningAnalyses: () => [],
      latestAnalysis: () => null,
      ticketOverride: () => null,
      createAnalysis: () => "an_1",
      setAnalysisWorker: vi.fn(),
      markAnalysisDiffOnly: vi.fn(),
      failAnalysis: vi.fn(),
      analysis: () => record,
    };
    const analysis = createAnalysis({
      bb: fake.bb,
      store,
      github: {},
      models: { selected: async () => null },
      settings: async () => ({ ticketUrlPattern: "notion", notionProjectProperty: "Project" }),
      onDiagramNodesChanged: vi.fn(),
    } as unknown as Parameters<typeof createAnalysis>[0]);
    return { ...fake, analysis, store };
  }

  it("is deleted when the worker finishes", async () => {
    const { analysis, handlers, metadata } = setup();
    await analysis.start(ref, { pr });
    const dir = metadata.get("thr_1")?.tempDir as string;
    expect(existsSync(join(dir, "an_1.diff"))).toBe(true);
    handlers.get("thread.idle")?.({ thread: { id: "thr_1" } });
    await vi.waitFor(() => expect(existsSync(dir)).toBe(false));
  });

  it("is deleted when the worker can't start", async () => {
    const { analysis, spawn, store } = setup();
    const before = new Set(readdirSync(tmpdir()));
    spawn.mockRejectedValueOnce(new Error("no provider"));
    await analysis.start(ref, { pr });
    expect(store.failAnalysis).toHaveBeenCalled();
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith("pr-xray-") && !before.has(name))).toEqual([]);
  });
});

describe("the chat context", () => {
  function setup() {
    const fake = fakeBb();
    const chat = createChat({
      bb: fake.bb,
      models: { selected: async () => null },
      loadPr: async () => pr,
      analysisFor: () => null,
    } as unknown as Parameters<typeof createChat>[0]);
    return { ...fake, chat };
  }

  it("lives in a private folder the agent is told about, and goes when the chat resets", async () => {
    const { chat, metadata } = setup();
    await chat.start(ref, "Why?");
    const stored = metadata.get("thr_1")!;
    const dir = stored.tempDir as string;
    expect(existsSync(join(dir, "context.md"))).toBe(true);
    expect(chatInstructions(stored)).toContain("context.md");
    await chat.reset(ref);
    expect(existsSync(dir)).toBe(false);
  });
});
