// Which model runs analysis and tagging. The user's choice lives in kv; the
// recommendation is the first available entry of a ranked list.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { modelSelectionSchema, type ModelSelection } from "../shared/schema";

/**
 * Ranked for this task: grouping hunks and explaining cross-file logic needs
 * solid code reasoning, but not a frontier model. Update as models change.
 */
export const RECOMMENDED_MODELS: readonly ModelSelection[] = [
  { providerId: "claude-code", model: "claude-sonnet-5-5", reasoningLevel: "medium" },
  { providerId: "claude-code", model: "claude-sonnet-5", reasoningLevel: "medium" },
  { providerId: "claude-code", model: "claude-sonnet-4-6", reasoningLevel: "medium" },
];

const KEY = "modelSelection";

export function createModels(bb: BbPluginApi) {
  async function available(selection: ModelSelection): Promise<boolean> {
    try {
      const { models } = await bb.sdk.providers.models({ providerId: selection.providerId });
      return models.some((model) => model.model === selection.model || model.id === selection.model);
    } catch {
      return false;
    }
  }

  async function recommended(): Promise<ModelSelection | null> {
    for (const candidate of RECOMMENDED_MODELS) {
      if (await available(candidate)) return candidate;
    }
    return null;
  }

  async function stored(): Promise<ModelSelection | null> {
    const parsed = modelSelectionSchema.safeParse(await bb.storage.kv.get(KEY));
    return parsed.success ? parsed.data : null;
  }

  async function setStored(selection: ModelSelection | null) {
    if (selection === null) await bb.storage.kv.delete(KEY);
    else await bb.storage.kv.set(KEY, selection);
  }

  /** The selection used at spawn time; null lets bb pick its defaults. */
  async function effective(): Promise<ModelSelection | null> {
    return (await stored()) ?? (await recommended());
  }

  return { recommended, stored, setStored, effective };
}

export type Models = ReturnType<typeof createModels>;

export function spawnModelArgs(selection: ModelSelection | null, reasoningOverride?: string) {
  if (selection === null) return {};
  return {
    providerId: selection.providerId,
    model: selection.model,
    reasoningLevel: reasoningOverride ?? selection.reasoningLevel,
    ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {}),
  };
}
