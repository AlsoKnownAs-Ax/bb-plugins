// "Ask about this PR": a bubble in the bottom-right corner of the review page
// that opens a chat with an agent that has the PR, its diff and the analysis.
import { useEffect, useState } from "react";
import { ThreadChat } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";
import type { PrRef } from "../shared/schema";
import { errorMessage, type Rpc } from "./useReview";

const SUGGESTIONS = [
  "Summarise this PR in a few bullet points.",
  "What could break with this change?",
  "Which part should I review most carefully, and why?",
  "Are there missing tests?",
];

export function ChatBubble({ rpc, prRef }: { rpc: Rpc; prRef: PrRef }) {
  const [open, setOpen] = useState(false);
  // undefined: not loaded yet; null: no chat for this PR yet.
  const [threadId, setThreadId] = useState<string | null | undefined>(undefined);
  const [focusRequest, setFocusRequest] = useState(0);

  useEffect(() => {
    if (!open || threadId !== undefined) return;
    rpc.call("chat.get", { ref: prRef }).then(
      (result) => setThreadId(result.threadId),
      (cause: unknown) => {
        toast.error(errorMessage(cause));
        setThreadId(null);
      },
    );
  }, [open, threadId, rpc, prRef]);

  useEffect(() => {
    if (open) setFocusRequest(Date.now());
  }, [open]);

  const reset = async () => {
    try {
      await rpc.call("chat.reset", { ref: prRef });
      setThreadId(null);
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };

  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-40 flex flex-col items-end gap-3">
      {open ? (
        <section
          aria-label="Ask about this PR"
          className="pointer-events-auto flex h-[min(600px,calc(100vh-8rem))] w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        >
          <header className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Icon name="Sparkles" fallback="Bot" className="size-4 text-muted-foreground" />
            <span className="flex-1 truncate text-sm font-medium">
              Ask about {prRef.repo}#{prRef.number}
            </span>
            {threadId ? (
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => void reset()} aria-label="Start a new chat">
                <Icon name="SquarePen" fallback="Plus" />
                New
              </Button>
            ) : null}
            <Button size="icon" variant="ghost" className="size-7" onClick={() => setOpen(false)} aria-label="Close chat">
              <span aria-hidden className="text-base leading-none">×</span>
            </Button>
          </header>
          <div className="min-h-0 flex-1">
            {threadId === undefined ? (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                <Icon name="Spinner" className="size-5 animate-spin" />
              </div>
            ) : threadId === null ? (
              <FirstQuestion
                focusRequest={focusRequest}
                onAsk={async (question) => {
                  const result = await rpc.call("chat.start", { ref: prRef, question });
                  setThreadId(result.threadId);
                  setFocusRequest(Date.now());
                }}
              />
            ) : (
              <ThreadChat key={threadId} threadId={threadId} variant="compact" focusRequest={focusRequest} className="h-full" />
            )}
          </div>
        </section>
      ) : null}
      <Button
        size="icon"
        className="pointer-events-auto size-12 rounded-full shadow-lg"
        onClick={() => setOpen((value) => !value)}
        aria-label={open ? "Close chat" : "Ask about this PR"}
        aria-expanded={open}
      >
        <Icon name={open ? "ChevronDown" : "MessageCircle"} fallback="Bot" className="size-5" />
      </Button>
    </div>
  );
}

function FirstQuestion({ focusRequest, onAsk }: { focusRequest: number; onAsk: (question: string) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState<HTMLTextAreaElement | null>(null);

  useEffect(() => input?.focus(), [input, focusRequest]);

  const ask = async (question: string) => {
    const text = question.trim();
    if (text === "" || sending) return;
    setSending(true);
    try {
      await onAsk(text);
    } catch (cause) {
      toast.error(errorMessage(cause));
      setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <p className="text-sm text-muted-foreground">
        Ask anything about this pull request. The agent has read its description, diff, review threads and the PR X-ray
        analysis. It only reads; it never changes code or posts to GitHub.
      </p>
      <div className="flex flex-col gap-1.5">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            disabled={sending}
            onClick={() => void ask(suggestion)}
            className="rounded-md border border-border px-2.5 py-1.5 text-left text-xs text-foreground hover:bg-muted disabled:opacity-50"
          >
            {suggestion}
          </button>
        ))}
      </div>
      <form
        className="mt-auto flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(value);
        }}
      >
        <Textarea
          ref={setInput}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void ask(value);
            }
          }}
          placeholder="Why does this PR change…?"
          rows={3}
          disabled={sending}
          className="resize-none text-sm"
        />
        <Button type="submit" size="sm" className="self-end" disabled={sending || value.trim() === ""}>
          {sending ? <Icon name="Spinner" className="animate-spin" /> : <Icon name="ArrowUp" fallback="Send" />}
          Ask
        </Button>
      </form>
    </div>
  );
}
