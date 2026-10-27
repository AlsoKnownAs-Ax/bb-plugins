// Settings page section: GitHub identity and the analysis model.
import { useCallback, useEffect, useState } from "react";
import { experimental_ProviderModelPicker as ProviderModelPicker, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { rpcContract } from "../shared/contract";
import type { ModelSelection } from "../shared/schema";
import { errorMessage } from "./useReview";

interface State {
  identity: { login: string; source: "token" | "gh" } | null;
  identityError: string | null;
  model: ModelSelection | null;
  recommended: ModelSelection | null;
}

const same = (a: ModelSelection | null, b: ModelSelection | null) =>
  a !== null && b !== null && a.providerId === b.providerId && a.model === b.model && a.reasoningLevel === b.reasoningLevel;

export function SettingsSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    rpc.call("settings.get").then(
      (result) => setState(result),
      (cause: unknown) => setError(errorMessage(cause)),
    );
  }, [rpc]);
  useEffect(load, [load]);

  const save = async (selection: ModelSelection | null) => {
    try {
      await rpc.call("settings.setModel", { selection });
      load();
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!state) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const effective = state.model ?? state.recommended;
  const isRecommended = same(effective, state.recommended);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <div className="text-sm font-medium">GitHub</div>
        {state.identity ? (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Icon name="CircleCheck" className="size-4" />
            Connected as <span className="font-medium text-foreground">@{state.identity.login}</span> via{" "}
            {state.identity.source === "token" ? "the token above" : "your gh login"}.
          </p>
        ) : (
          <p className="text-sm text-destructive">{state.identityError}</p>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium">Analysis model</div>
        <p className="text-sm text-muted-foreground">
          Used for grouping, explanations and diagrams. A strong mid-size model is enough; you don’t need your most powerful one. “AI tag” on a comment uses Haiku when available.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {effective ? (
            <ProviderModelPicker
              value={{
                providerId: effective.providerId,
                model: effective.model,
                reasoningLevel: effective.reasoningLevel as never,
                ...(effective.serviceTier ? { serviceTier: effective.serviceTier as never } : {}),
              }}
              onChange={(value) =>
                void save({
                  providerId: value.providerId,
                  model: value.model,
                  reasoningLevel: value.reasoningLevel,
                  ...(value.serviceTier ? { serviceTier: value.serviceTier } : {}),
                })
              }
            />
          ) : (
            <span className="text-sm text-muted-foreground">bb default model</span>
          )}
          {isRecommended ? (
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium">Recommended</span>
          ) : state.recommended ? (
            <Button size="sm" variant="outline" onClick={() => void save(null)}>
              Use recommended ({state.recommended.model}, {state.recommended.reasoningLevel})
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
