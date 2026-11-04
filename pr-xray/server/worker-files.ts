// Private temp folders for the files workers read: PR diffs and chat context.
// mkdtemp gives each one a random name that only this OS user can open.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const PREFIX = "pr-xray-";

export function createWorkerDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), PREFIX));
}

/** Deletes a folder from createWorkerDir, and refuses any other path. */
export async function removeWorkerDir(dir: unknown): Promise<void> {
  if (typeof dir !== "string" || dirname(dir) !== tmpdir() || !basename(dir).startsWith(PREFIX)) return;
  await rm(dir, { recursive: true, force: true });
}

/** Deletes the folder a worker thread recorded as `tempDir` in its metadata. */
export async function removeThreadDir(bb: BbPluginApi, threadId: string): Promise<void> {
  try {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId });
    await removeWorkerDir(metadata.tempDir);
  } catch (error) {
    bb.log.warn(`remove temp files of ${threadId}: ${String(error)}`);
  }
}
