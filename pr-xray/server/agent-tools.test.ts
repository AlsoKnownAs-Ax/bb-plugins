import { describe, expect, it } from "vitest";
import { ANALYSIS_TOOL } from "./analysis";
import { agentTools, REVIEW_TOOL } from "./agent-tools";
import { TAGS_TOOL } from "./comments";

describe("agent tools", () => {
  it("offers the review tool to the user's own threads", () => {
    expect(agentTools(undefined)).toEqual([REVIEW_TOOL]);
  });

  it("gives workers only the tool their job needs", () => {
    expect(agentTools("analysis")).toEqual([ANALYSIS_TOOL]);
    expect(agentTools("tagging")).toEqual([TAGS_TOOL]);
    expect(agentTools("chat")).toEqual([]);
    expect(agentTools("fix")).toEqual([]);
  });
});
