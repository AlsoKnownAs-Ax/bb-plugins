// The dialogs that ask before an agent reads text the user didn't write.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { prRefKey } from "../shared/pr-ref";
import type { PrDetails, PrRef } from "../shared/schema";
import { needsAgentWarning, type AgentJob } from "./agent-trust";

interface AgentConfirm {
  /** Asks once per PR, and only when other people's text is involved. */
  confirmAgent: (job: AgentJob) => Promise<boolean>;
  /** Asks every time: this agent can push, and it reads everyone's comments. */
  confirmOthersComments: () => Promise<boolean>;
}

/** Outside a review page there is nobody to ask, so the answer is no. */
const AgentConfirmContext = createContext<AgentConfirm>({
  confirmAgent: () => Promise.resolve(false),
  confirmOthersComments: () => Promise.resolve(false),
});

export const useAgentConfirmContext = () => useContext(AgentConfirmContext);

const COPY = {
  agent: {
    title: "Let an agent read someone else's text?",
    description:
      "This PR has content written by other people, and a malicious PR or comment can prompt-inject the agent that reads it. With Codex, that agent can reach the internet and run gh with your login. Continue only if you trust everyone who wrote this PR and its comments.",
    action: "Continue",
  },
  others: {
    title: "Send everyone's comments to a fix agent?",
    description:
      "An agent that can push to this branch will read the comments, including ones from other people. On a public repo anyone can post a comment, and its text could prompt-inject the agent. Continue only if you trust everyone who commented.",
    action: "Fix with all comments",
  },
};

export function useAgentConfirm(prRef: PrRef, pr: PrDetails | null) {
  const warningKey = `pr-xray:agent-warning:${prRefKey(prRef)}`;
  const [question, setQuestion] = useState<{ kind: keyof typeof COPY; answer: (accepted: boolean) => void } | null>(null);
  // A ref, so these callbacks stay the same while the review data refreshes.
  const latestPr = useRef(pr);
  latestPr.current = pr;

  const confirmAgent = useCallback(
    (job: AgentJob) => {
      const current = latestPr.current;
      if (current === null || !needsAgentWarning(current, job) || localStorage.getItem(warningKey)) return Promise.resolve(true);
      return new Promise<boolean>((resolve) =>
        setQuestion({
          kind: "agent",
          answer: (accepted) => {
            if (accepted) localStorage.setItem(warningKey, "accepted");
            resolve(accepted);
          },
        }),
      );
    },
    [warningKey],
  );
  const confirmOthersComments = useCallback(
    () => new Promise<boolean>((resolve) => setQuestion({ kind: "others", answer: resolve })),
    [],
  );

  const answer = (accepted: boolean) => {
    question?.answer(accepted);
    setQuestion(null);
  };
  const copy = question ? COPY[question.kind] : null;
  const dialog = (
    <Dialog open={question !== null} onOpenChange={(open) => !open && answer(false)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy?.title}</DialogTitle>
          <DialogDescription>{copy?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => answer(false)}>
            Cancel
          </Button>
          <Button onClick={() => answer(true)}>{copy?.action}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { confirmAgent, confirmOthersComments, dialog };
}

export function AgentConfirmProvider({ value, children }: { value: AgentConfirm; children: ReactNode }) {
  return <AgentConfirmContext.Provider value={value}>{children}</AgentConfirmContext.Provider>;
}
