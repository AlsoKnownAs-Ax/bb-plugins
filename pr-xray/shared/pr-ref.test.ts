import { describe, expect, it } from "vitest";
import { parsePrRef, parsePrSubPath, prRefKey, prRefToSubPath, prRefUrl } from "./pr-ref";

const ref = { owner: "acme", repo: "web.app", number: 42 };

describe("parsePrRef", () => {
  it("accepts PR URLs, including tab paths and queries", () => {
    expect(parsePrRef("https://github.com/acme/web.app/pull/42")).toEqual(ref);
    expect(parsePrRef("  https://www.github.com/acme/web.app/pull/42/files?w=1 ")).toEqual(ref);
  });

  it("accepts the short form", () => {
    expect(parsePrRef("acme/web.app#42")).toEqual(ref);
  });

  it("rejects anything else", () => {
    expect(parsePrRef("https://github.com/acme/web.app/issues/42")).toBeNull();
    expect(parsePrRef("https://gitlab.com/acme/web.app/pull/42")).toBeNull();
    expect(parsePrRef("acme/web.app")).toBeNull();
  });
});

describe("sub paths and keys", () => {
  it("round-trips the review page sub path", () => {
    expect(parsePrSubPath(prRefToSubPath(ref))).toEqual(ref);
    expect(parsePrSubPath("acme/web.app")).toBeNull();
  });

  it("lowercases the key and keeps the URL's case", () => {
    const mixedCase = { owner: "Acme", repo: "Web", number: 1 };
    expect(prRefKey(mixedCase)).toBe("acme/web#1");
    expect(prRefUrl(mixedCase)).toBe("https://github.com/Acme/Web/pull/1");
  });
});
