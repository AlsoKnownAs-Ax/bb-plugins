import { describe, expect, it } from "vitest";
import { stripMarker, withMarker } from "./comments";

describe("comment tag markers", () => {
  it("adds a marker that strips back to the original body", () => {
    const marked = withMarker("Needs a test.", "missing-test");
    expect(marked).toBe("Needs a test.\n\n<!-- pr-xray: tag=missing-test -->");
    expect(stripMarker(marked)).toBe("Needs a test.");
  });

  it("replaces an existing marker instead of stacking them", () => {
    const retagged = withMarker(withMarker("Rename this.", "naming"), "design");
    expect(retagged).toBe("Rename this.\n\n<!-- pr-xray: tag=design -->");
  });

  it("leaves other text alone", () => {
    expect(stripMarker("A plain comment.")).toBe("A plain comment.");
    const quoted = "<!-- pr-xray: tag=bug --> is the format";
    expect(stripMarker(quoted)).toBe(quoted);
  });
});
