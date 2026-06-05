import { test } from "node:test";
import assert from "node:assert/strict";

import { parseWatchPaths, filterNewPaths } from "../src/init.js";

test("parseWatchPaths — extracts the watchPaths array", () => {
  assert.deepStrictEqual(
    parseWatchPaths(JSON.stringify({ watchPaths: ["/a", "/b"] })),
    ["/a", "/b"]
  );
});

test("parseWatchPaths — tolerant of missing array / malformed JSON / bad entries", () => {
  assert.deepStrictEqual(parseWatchPaths(JSON.stringify({ other: 1 })), []);
  assert.deepStrictEqual(parseWatchPaths("not json{{"), []);
  assert.deepStrictEqual(parseWatchPaths(""), []);
  // Non-string and empty entries are dropped.
  assert.deepStrictEqual(
    parseWatchPaths(JSON.stringify({ watchPaths: ["/a", 5, "", "/b"] })),
    ["/a", "/b"]
  );
});

test("filterNewPaths — keeps only genuinely-new paths, order preserved", () => {
  assert.deepStrictEqual(
    filterNewPaths(["/a", "/b"], ["/b", "/c", "/d"]),
    ["/c", "/d"]
  );
});

test("filterNewPaths — removes intra-candidate duplicates", () => {
  assert.deepStrictEqual(
    filterNewPaths(["/a"], ["/c", "/c", "/d", "/c"]),
    ["/c", "/d"]
  );
});

test("filterNewPaths — empty candidates → empty (nothing to add)", () => {
  assert.deepStrictEqual(filterNewPaths(["/a", "/b"], []), []);
  // All candidates already watched → empty.
  assert.deepStrictEqual(filterNewPaths(["/a", "/b"], ["/a", "/b"]), []);
});
