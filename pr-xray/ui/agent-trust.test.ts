import { describe, expect, it } from "vitest";
import type { PrDetails } from "../shared/schema";
import { needsAgentWarning } from "./agent-trust";

const comment = (author: string) => ({ author });
const pr = (isOwnPr: boolean, ...authors: string[]) =>
  ({ isOwnPr, viewer: "ann", threads: [{ comments: authors.map(comment) }] }) as unknown as PrDetails;

describe("warning before an agent reads other people's text", () => {
  it("warns a fix on someone else's PR, because the agent works in their branch", () => {
    expect(needsAgentWarning(pr(false), "fix")).toBe(true);
    expect(needsAgentWarning(pr(true, "mallory"), "fix")).toBe(false);
  });

  it("warns for every job on someone else's PR", () => {
    expect(needsAgentWarning(pr(false), "analysis")).toBe(true);
    expect(needsAgentWarning(pr(false), "chat")).toBe(true);
  });

  it("stays quiet on your own PR with only your comments", () => {
    expect(needsAgentWarning(pr(true, "Ann"), "analysis")).toBe(false);
    expect(needsAgentWarning(pr(true, "Ann"), "chat")).toBe(false);
  });

  it("warns chat on your own PR when others commented, because chat reads the threads", () => {
    expect(needsAgentWarning(pr(true, "ann", "mallory"), "chat")).toBe(true);
    expect(needsAgentWarning(pr(true, "ann", "mallory"), "analysis")).toBe(false);
  });
});
