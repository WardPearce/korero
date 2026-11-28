import { expect, test } from "bun:test";
import { pushRecentEmoji } from "../src/lib/recent-emoji";

test("recent emoji puts the newest first without duplicates", () => {
  expect(pushRecentEmoji([], "👍")).toEqual(["👍"]);
  expect(pushRecentEmoji(["😀", "👍", "🎉"], "👍")).toEqual(["👍", "😀", "🎉"]);
});

test("recent emoji drops the oldest past the limit", () => {
  expect(pushRecentEmoji(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
});
