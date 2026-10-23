// The panel root: open a PR and see recent reviews.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { rpcContract } from "../shared/contract";
import { parsePrRef, prRefToSubPath, REVIEW_PANEL_PATH } from "../shared/pr-ref";
import type { ReviewSummary } from "../shared/schema";
import { uiStore } from "./store";
import { errorMessage } from "./useReview";

export function useOpenPr() {
  const navigate = useBbNavigate();
  return useCallback(
    (input: string): string | null => {
      const ref = parsePrRef(input);
      if (ref === null) return "Paste a GitHub pull request URL, e.g. https://github.com/owner/repo/pull/123";
      uiStore.set({ focusOnOpen: true, openDialog: false });
      navigate.toPluginPanel(REVIEW_PANEL_PATH, { subPath: prRefToSubPath(ref) });
      return null;
    },
    [navigate],
  );
}

const STATUS_LABEL: Record<ReviewSummary["analysisStatus"], string> = {
  none: "not analysed",
  running: "analysing…",
  done: "analysed",
  failed: "analysis failed",
};

export function HomePage() {
  const rpc = useRpc<typeof rpcContract>();
  const openPr = useOpenPr();
  const navigate = useBbNavigate();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<ReviewSummary[] | null>(null);

  const load = useCallback(() => {
    rpc.call("review.recent").then(
      (result) => setReviews(result.reviews),
      (cause: unknown) => setError(errorMessage(cause)),
    );
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime("analysis-changed", load);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(openPr(url));
  };

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-5">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            Paste a pull request to see its diff grouped by concern, with a visual explanation of the change.
          </p>
        </div>
        <form onSubmit={submit} className="flex items-center gap-2">
          <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/repo/pull/123" autoFocus />
          <Button type="submit" disabled={url.trim() === ""}>
            <Icon name="GitPullRequest" />
            Review
          </Button>
        </form>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="space-y-2">
          <h2 className="text-sm font-medium">Recent reviews</h2>
          {reviews === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : reviews.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              No reviews yet. Use the command palette (“PR X-ray: Review a pull request”) from anywhere in bb.
            </div>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {reviews.map((review) => (
                <li key={`${review.ref.owner}/${review.ref.repo}/${review.ref.number}`}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-state-hover"
                    onClick={() => navigate.toPluginPanel(REVIEW_PANEL_PATH, { subPath: prRefToSubPath(review.ref) })}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{review.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {review.ref.owner}/{review.ref.repo}#{review.ref.number}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">{STATUS_LABEL[review.analysisStatus]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
