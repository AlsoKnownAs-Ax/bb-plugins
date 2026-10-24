// Run with: node --test lib/project-emojis.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProjectEmojis, withEmoji } from "./project-emojis.ts";

test("parses lines, case-insensitive, last colon wins", () => {
  const map = parseProjectEmojis("bb-plugins: 🧩\r\n\n  Personal :🏠 \nno colon\nempty:\nA: B: 🔥");
  assert.deepEqual([...map], [["bb-plugins", "🧩"], ["personal", "🏠"], ["a: b", "🔥"]]);
  assert.equal(withEmoji(map, "PERSONAL"), "🏠 PERSONAL");
  assert.equal(withEmoji(map, "Other"), "Other");
  assert.equal(parseProjectEmojis(undefined).size, 0);
});
