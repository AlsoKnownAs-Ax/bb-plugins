import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ReviewGet, rpcContract } from "../shared/contract";
import type { PrRef } from "../shared/schema";
import { prRefKey } from "../shared/pr-ref";

export type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
export type { ReviewGet };

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return String(error);
}

/** Loads one PR's review state and keeps it fresh from realtime signals. */
export function useReview(ref: PrRef) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<ReviewGet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = prRefKey(ref);
  const latestKey = useRef(key);
  latestKey.current = key;
  const refRef = useRef(ref);
  refRef.current = ref;

  const refetch = useCallback(() => {
    const requested = key;
    rpc.call("review.get", { ref: refRef.current }).then(
      (result) => {
        if (latestKey.current !== requested) return;
        setData(result);
        setError(null);
      },
      (cause: unknown) => {
        if (latestKey.current === requested) setError(errorMessage(cause));
      },
    );
  }, [rpc, key]);

  useEffect(() => {
    setData(null);
    setError(null);
    refetch();
  }, [refetch]);

  const onSignal = useCallback(
    (payload: unknown) => {
      if ((payload as { key?: string } | null)?.key === key) refetch();
    },
    [key, refetch],
  );
  useRealtime("analysis-changed", onSignal);
  useRealtime("comments-changed", onSignal);

  return { rpc, data, error, refetch };
}
